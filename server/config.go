package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type config struct {
	appDir, distPath, statePath, address, version string
	maxFileBytes                                  int64
	restrictRoots                                 bool
	configuredRoot                                string
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func loadConfig() (config, error) {
	appDir, err := os.Getwd()
	if err != nil {
		return config{}, err
	}
	if explicit := os.Getenv("FNEDITOR_APP_DIR"); explicit != "" {
		appDir = explicit
	} else if _, err := os.Stat(filepath.Join(appDir, "package.json")); err != nil {
		if executable, err := os.Executable(); err == nil {
			for _, candidate := range []string{filepath.Dir(executable), filepath.Dir(filepath.Dir(executable))} {
				if info, err := os.Stat(filepath.Join(candidate, "dist")); err == nil && info.IsDir() {
					appDir = candidate
					break
				}
			}
		}
	}
	appDir, err = filepath.Abs(appDir)
	if err != nil {
		return config{}, err
	}
	statePath, err := filepath.Abs(firstNonEmpty(os.Getenv("FNEDITOR_STATE_PATH"), filepath.Join(appDir, ".fneditor-state.json")))
	if err != nil {
		return config{}, err
	}
	port := firstNonEmpty(os.Getenv("PORT"), "39280")
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return config{}, fmt.Errorf("invalid PORT: %q", port)
	}
	maxBytes := int64(5 * 1024 * 1024)
	if value := os.Getenv("FNEDITOR_MAX_FILE_BYTES"); value != "" {
		maxBytes, err = strconv.ParseInt(value, 10, 64)
		if err != nil || maxBytes < 1 {
			return config{}, fmt.Errorf("invalid FNEDITOR_MAX_FILE_BYTES: %q", value)
		}
	}
	restricted, _ := parseBoolean(os.Getenv("FNEDITOR_RESTRICT_ROOTS"))
	cfg := config{appDir: appDir, distPath: filepath.Join(appDir, "dist"), statePath: statePath,
		address:      net.JoinHostPort(firstNonEmpty(os.Getenv("FNEDITOR_HOST"), "0.0.0.0"), port),
		maxFileBytes: maxBytes, restrictRoots: restricted,
		configuredRoot: firstNonEmpty(os.Getenv("FNEDITOR_ROOT"), os.Getenv("FILES_ROOT"))}
	cfg.version = firstNonEmpty(os.Getenv("FNCODE_VERSION"), os.Getenv("FNEDITOR_VERSION"))
	if cfg.version == "" {
		cfg.version = readVersion(appDir)
	}
	return cfg, nil
}

func readVersion(appDir string) string {
	if version != "unknown" {
		return version
	}
	for _, candidate := range []string{filepath.Join(appDir, "package.json"), filepath.Join(appDir, "..", "package.json"), filepath.Join(appDir, "server", "package.json")} {
		data, err := os.ReadFile(candidate)
		var pkg struct {
			Version string `json:"version"`
		}
		if err == nil && json.Unmarshal(data, &pkg) == nil && pkg.Version != "" {
			return pkg.Version
		}
	}
	for _, base := range []string{appDir, filepath.Dir(appDir), filepath.Dir(filepath.Dir(appDir))} {
		data, _ := os.ReadFile(filepath.Join(base, "manifest"))
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "version=") {
				return strings.TrimSpace(strings.TrimPrefix(line, "version="))
			}
		}
	}
	return "unknown"
}

func (s *server) readState() map[string]any {
	data, err := os.ReadFile(s.config.statePath)
	state := map[string]any{}
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("read state: %v", err)
		}
		return state
	}
	if err := json.Unmarshal(data, &state); err != nil || state == nil {
		log.Printf("invalid state file: %v", err)
		return map[string]any{}
	}
	return state
}

func (s *server) updateState(changes map[string]any) error {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	state := s.readState()
	for key, value := range changes {
		state[key] = value
	}
	state["updatedAt"] = isoTime(time.Now())
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.config.statePath), 0755); err != nil {
		return err
	}
	// Rename a complete file so concurrent readers and service restarts see valid JSON.
	f, err := os.CreateTemp(filepath.Dir(s.config.statePath), ".fneditor-state-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(append(data, '\n'))
	syncErr := f.Sync()
	closeErr := f.Close()
	for _, err := range []error{writeErr, syncErr, closeErr} {
		if err != nil {
			return err
		}
	}
	return os.Rename(f.Name(), s.config.statePath)
}

func isoTime(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }
func unique(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			result = append(result, value)
			seen[value] = true
		}
	}
	return result
}

var volumePattern = regexp.MustCompile(`^vol(\d+)$`)

func defaultRootCandidates() []string {
	userIDs := unique([]string{os.Getenv("FNEDITOR_USER_ID"), os.Getenv("TRIM_USER_ID"), os.Getenv("TRIM_UID"), os.Getenv("PUID"), "1000"})
	volumes := []string{}
	entries, _ := os.ReadDir(string(filepath.Separator))
	for _, entry := range entries {
		if entry.IsDir() && volumePattern.MatchString(entry.Name()) {
			volumes = append(volumes, entry.Name())
		}
	}
	sort.Slice(volumes, func(i, j int) bool {
		a, _ := strconv.Atoi(volumes[i][3:])
		b, _ := strconv.Atoi(volumes[j][3:])
		return a < b
	})
	candidates := []string{}
	priorityIDs := unique(append([]string{"1000"}, userIDs...))
	for _, uid := range priorityIDs {
		for _, volume := range volumes {
			candidate := filepath.Join(string(filepath.Separator), volume, uid)
			if entries, err := os.ReadDir(candidate); err == nil && len(entries) > 0 {
				candidates = append(candidates, candidate)
			}
		}
	}
	for _, uid := range userIDs {
		candidates = append(candidates, "/share/home/"+uid+"/webdav", "/share/home/"+uid)
	}
	for _, volume := range volumes {
		for _, uid := range userIDs {
			candidates = append(candidates, filepath.Join(string(filepath.Separator), volume, uid))
		}
	}
	return unique(candidates)
}

func existingDirectory(candidate string) (string, error) {
	if strings.TrimSpace(candidate) == "" {
		return "", os.ErrNotExist
	}
	absolute, err := filepath.Abs(strings.TrimSpace(candidate))
	if err != nil {
		return "", err
	}
	real, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	if filepath.Dir(real) == real {
		return "", fail(400, "根目录不能设置为系统根目录")
	}
	info, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fail(400, "根目录必须是文件夹")
	}
	return real, nil
}

func inside(base, target string) bool {
	relative, err := filepath.Rel(base, target)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func (s *server) allowedBases() []string {
	candidates := append(defaultRootCandidates(), filepath.Dir(s.config.statePath), filepath.Join(filepath.Dir(s.config.statePath), "files"))
	bases := []string{}
	for _, candidate := range unique(candidates) {
		if real, err := existingDirectory(candidate); err == nil {
			bases = append(bases, real)
		}
	}
	return unique(bases)
}
func (s *server) allowedRoot(target string) bool {
	if !s.config.restrictRoots {
		return true
	}
	for _, base := range s.allowedBases() {
		if inside(base, target) {
			return true
		}
	}
	return false
}

func (s *server) resolveRoot(state map[string]any) (string, error) {
	if saved, err := existingDirectory(stringValue(state["lastRootPath"])); err == nil && s.allowedRoot(saved) {
		return saved, nil
	}
	if configured := s.config.configuredRoot; configured != "" {
		real, err := existingDirectory(configured)
		if err != nil {
			return "", fmt.Errorf("FNEDITOR_ROOT: %w", err)
		}
		if !s.allowedRoot(real) {
			return "", fail(403, "只能选择飞牛“我的文件”目录，例如 /vol2/1000 或 /vol2/1000/docker")
		}
		return real, nil
	}
	home, _ := os.UserHomeDir()
	workingDir, _ := os.Getwd()
	candidates := append(defaultRootCandidates(), filepath.Join(home, "我的文件"), filepath.Join(home, "My Files"), workingDir)
	for _, candidate := range candidates {
		if real, err := existingDirectory(candidate); err == nil && s.allowedRoot(real) {
			return real, nil
		}
	}
	fallback := filepath.Join(filepath.Dir(s.config.statePath), "files")
	if err := os.MkdirAll(fallback, 0755); err != nil {
		return "", err
	}
	return existingDirectory(fallback)
}

func (s *server) meta() map[string]any {
	s.eventsMu.Lock()
	enabled := s.debugEnabled
	s.eventsMu.Unlock()
	return map[string]any{"version": s.config.version, "rootLabel": s.rootLabel, "rootPath": s.rootPath, "maxFileBytes": s.config.maxFileBytes, "debugLoggingEnabled": enabled}
}

// Caller holds workspaceMu to keep root changes and file requests consistent.
func (s *server) setRoot(next string) (map[string]any, error) {
	if strings.TrimSpace(next) == "" {
		return nil, fail(400, "缺少根目录路径")
	}
	real, err := existingDirectory(next)
	if os.IsNotExist(err) {
		return nil, fail(404, "根目录不存在")
	}
	if err != nil {
		return nil, err
	}
	if !s.allowedRoot(real) {
		return nil, fail(403, "只能选择飞牛“我的文件”目录，例如 /vol2/1000 或 /vol2/1000/docker")
	}
	label := filepath.Base(real)
	if err := s.updateState(map[string]any{"lastRootPath": real, "lastRootLabel": label}); err != nil {
		return nil, err
	}
	s.rootPath, s.rootLabel = real, label
	return s.meta(), nil
}
