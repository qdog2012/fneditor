package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
)

type fileTarget struct{ absolute, real, relative string }
type treeItem struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"`
	Size       int64  `json:"size"`
	ModifiedAt string `json:"modifiedAt"`
}
type filePayload struct {
	Path         string `json:"path"`
	AbsolutePath string `json:"absolutePath"`
	Name         string `json:"name"`
	Content      string `json:"content"`
	Encoding     string `json:"encoding"`
	HasBom       bool   `json:"hasBom"`
	LineEnding   string `json:"lineEnding"`
	ModifiedAt   string `json:"modifiedAt"`
	Size         int64  `json:"size"`
}
type searchResult struct {
	Path      string  `json:"path"`
	Name      string  `json:"name"`
	Type      string  `json:"type"`
	MatchedBy string  `json:"matchedBy"`
	Line      int     `json:"line,omitempty"`
	Preview   *string `json:"preview,omitempty"`
}

func normalizeClientPath(input string) (string, error) {
	value := strings.TrimSpace(strings.ReplaceAll(input, "\\", "/"))
	if strings.ContainsRune(value, 0) {
		return "", fail(400, "路径不能包含空字符")
	}
	normalized := path.Clean(strings.TrimLeft(value, "/"))
	if normalized == "." {
		return "", nil
	}
	if normalized == ".." || strings.HasPrefix(normalized, "../") {
		return "", fail(400, "路径不能越过根目录")
	}
	return normalized, nil
}
func (s *server) ensureInside(target string) error {
	if !inside(s.rootPath, target) {
		return fail(403, "路径不在允许访问的目录内")
	}
	return nil
}
func (s *server) absolutePath(client string) (fileTarget, error) {
	relative, err := normalizeClientPath(client)
	if err != nil {
		return fileTarget{}, err
	}
	absolute := filepath.Join(s.rootPath, filepath.FromSlash(relative))
	if err := s.ensureInside(absolute); err != nil {
		return fileTarget{}, err
	}
	return fileTarget{absolute: absolute, relative: relative}, nil
}
func (s *server) existingPath(client string) (fileTarget, error) {
	target, err := s.absolutePath(client)
	if err != nil {
		return target, err
	}
	target.real, err = filepath.EvalSymlinks(target.absolute)
	if err != nil {
		return target, err
	}
	return target, s.ensureInside(target.real)
}
func (s *server) writablePath(client string) (fileTarget, error) {
	target, err := s.absolutePath(client)
	if err != nil {
		return target, err
	}
	parent, err := filepath.EvalSymlinks(filepath.Dir(target.absolute))
	if err != nil {
		return target, err
	}
	if err := s.ensureInside(parent); err != nil {
		return target, err
	}
	return target, nil
}
func exists(name string) bool      { _, err := os.Stat(name); return err == nil }
func entryExists(name string) bool { _, err := os.Lstat(name); return err == nil }
func clientPath(base, target string) string {
	relative, _ := filepath.Rel(base, target)
	if relative == "." {
		return ""
	}
	return filepath.ToSlash(relative)
}

func (s *server) writableFile(client, requestedAbsolute string) (fileTarget, error) {
	requestedAbsolute = strings.TrimSpace(requestedAbsolute)
	if requestedAbsolute == "" {
		target, err := s.writablePath(client)
		if err != nil {
			return target, err
		}
		if entryExists(target.absolute) {
			target, err = s.existingPath(client)
			if err != nil {
				return target, err
			}
			info, err := os.Stat(target.real)
			if err != nil {
				return target, err
			}
			if !info.Mode().IsRegular() {
				return target, fail(400, "目标路径不是文件")
			}
		}
		return target, nil
	}
	if !filepath.IsAbs(requestedAbsolute) {
		return fileTarget{}, fail(400, "absolutePath 必须是绝对路径")
	}
	absolute := filepath.Clean(requestedAbsolute)
	if entryExists(absolute) {
		real, err := filepath.EvalSymlinks(absolute)
		if err != nil {
			return fileTarget{}, err
		}
		info, err := os.Stat(real)
		if err != nil {
			return fileTarget{}, err
		}
		if !info.Mode().IsRegular() {
			return fileTarget{}, fail(400, "目标路径不是文件")
		}
		absolute = real
	} else {
		parent, err := filepath.EvalSymlinks(filepath.Dir(absolute))
		if err != nil {
			return fileTarget{}, err
		}
		if !s.allowedRoot(parent) {
			return fileTarget{}, fail(403, "保存路径不在允许访问的目录内")
		}
		absolute = filepath.Join(parent, filepath.Base(absolute))
	}
	if !s.allowedRoot(absolute) {
		return fileTarget{}, fail(403, "保存路径不在允许访问的目录内")
	}
	relative, err := normalizeClientPath(client)
	if err != nil {
		return fileTarget{}, err
	}
	if inside(s.rootPath, absolute) {
		relative = clientPath(s.rootPath, absolute)
	} else if relative == "" {
		relative = filepath.Base(absolute)
	}
	return fileTarget{absolute: absolute, real: absolute, relative: relative}, nil
}

func (s *server) sizeError(action string) error {
	return fail(413, fmt.Sprintf("文件超过 %.0fMB，已阻止%s", float64(s.config.maxFileBytes)/1024/1024, action))
}
func (s *server) readBounded(name string) ([]byte, os.FileInfo, error) {
	// Check before opening, since opening a FIFO can block indefinitely.
	initial, err := os.Stat(name)
	if err != nil {
		return nil, nil, err
	}
	if !initial.Mode().IsRegular() {
		return nil, nil, fail(400, "目标路径不是文件")
	}
	if initial.Size() > s.config.maxFileBytes {
		return nil, nil, s.sizeError("打开")
	}
	f, err := os.Open(name)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, fail(400, "目标路径不是文件")
	}
	if info.Size() > s.config.maxFileBytes {
		return nil, nil, s.sizeError("打开")
	}
	data, err := io.ReadAll(io.LimitReader(f, s.config.maxFileBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if int64(len(data)) > s.config.maxFileBytes {
		return nil, nil, s.sizeError("打开")
	}
	return data, info, nil
}
func (s *server) readFile(real, relative string) (filePayload, error) {
	data, info, err := s.readBounded(real)
	if err != nil {
		return filePayload{}, err
	}
	decoded, ok := decodeText(data)
	if !ok {
		return filePayload{}, fail(415, "二进制文件暂不支持直接编辑")
	}
	ending := detectLineEnding(decoded.content)
	if usesLF(real, decoded.content) {
		ending = "lf"
	}
	return filePayload{relative, real, filepath.Base(real), decoded.content, decoded.encoding, decoded.hasBom, ending, isoTime(info.ModTime()), info.Size()}, nil
}

func (s *server) readDirectory(client string) ([]treeItem, error) {
	target, err := s.existingPath(client)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(target.real)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fail(400, "目标路径不是文件夹")
	}
	entries, err := os.ReadDir(target.real)
	if err != nil {
		if os.IsPermission(err) {
			return nil, fail(403, "没有权限读取目录："+target.real)
		}
		return nil, err
	}
	items := []treeItem{}
	for _, entry := range entries {
		real, err := filepath.EvalSymlinks(filepath.Join(target.real, entry.Name()))
		if err != nil || s.ensureInside(real) != nil {
			continue
		}
		info, err := os.Stat(real)
		if err != nil {
			continue
		}
		kind := "file"
		if info.IsDir() {
			kind = "directory"
		}
		items = append(items, treeItem{entry.Name(), path.Join(target.relative, entry.Name()), kind, info.Size(), isoTime(info.ModTime())})
	}
	ordering := collate.New(language.SimplifiedChinese, collate.Numeric, collate.IgnoreCase, collate.IgnoreDiacritics)
	sort.SliceStable(items, func(i, j int) bool {
		if items[i].Type != items[j].Type {
			return items[i].Type == "directory"
		}
		return ordering.CompareString(items[i].Name, items[j].Name) < 0
	})
	return items, nil
}

func (s *server) search(ctx context.Context, query, dir string, limit int) ([]searchResult, error) {
	results := []searchResult{}
	keyword := strings.ToLower(strings.TrimSpace(query))
	if keyword == "" {
		return results, nil
	}
	if limit == 0 {
		limit = 120
	}
	limit = max(1, min(limit, 300))
	target, err := s.existingPath(dir)
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(target.real)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fail(400, "搜索起点必须是文件夹")
	}
	visited := map[string]bool{}
	var walk func(string, string) error
	walk = func(directory, clientDir string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if len(results) >= limit || visited[directory] {
			return nil
		}
		visited[directory] = true
		entries, err := os.ReadDir(directory)
		if err != nil {
			return nil
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if len(results) >= limit {
				return nil
			}
			real, err := filepath.EvalSymlinks(filepath.Join(directory, entry.Name()))
			if err != nil || s.ensureInside(real) != nil {
				continue
			}
			info, err := os.Stat(real)
			if err != nil {
				continue
			}
			itemPath := path.Join(clientDir, entry.Name())
			matched := strings.Contains(strings.ToLower(entry.Name()), keyword) || strings.Contains(strings.ToLower(itemPath), keyword)
			if info.IsDir() {
				if matched {
					results = append(results, searchResult{Path: itemPath, Name: entry.Name(), Type: "directory", MatchedBy: "name"})
				}
				if err := walk(real, itemPath); err != nil {
					return err
				}
				continue
			}
			if !info.Mode().IsRegular() {
				continue
			}
			if matched {
				results = append(results, searchResult{Path: itemPath, Name: entry.Name(), Type: "file", MatchedBy: "name"})
				if len(results) >= limit {
					return nil
				}
			}
			data, _, err := s.readBounded(real)
			if err != nil {
				continue
			}
			decoded, ok := decodeText(data)
			if !ok {
				continue
			}
			for i, line := range strings.Split(decoded.content, "\n") {
				if strings.Contains(strings.ToLower(line), keyword) {
					preview := truncateString(strings.TrimSpace(line), 180)
					results = append(results, searchResult{itemPath, entry.Name(), "file", "content", i + 1, &preview})
					break
				}
			}
		}
		return nil
	}
	err = walk(target.real, target.relative)
	return results, err
}

func writeAndSync(name string, data []byte, flags int) error {
	f, err := os.OpenFile(name, flags, 0666)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(data)
	syncErr := f.Sync()
	closeErr := f.Close()
	for _, err := range []error{writeErr, syncErr, closeErr} {
		if err != nil {
			return err
		}
	}
	return nil
}

func (s *server) saveFile(w http.ResponseWriter, r *http.Request) (any, error) {
	body, err := decodeBody(w, r)
	if err != nil {
		return nil, err
	}
	client, pathOK := body["path"].(string)
	content, contentOK := body["content"].(string)
	if !pathOK || !contentOK {
		return nil, fail(400, "缺少 path 或 content")
	}
	target, err := s.writableFile(client, stringValue(body["absolutePath"]))
	if err != nil {
		return nil, err
	}
	ending := saveLineEnding(target.absolute, stringValue(body["lineEnding"]), content)
	content = normalizeLineEndings(content, ending)
	encoding := "utf8"
	if value, ok := body["encoding"].(string); ok {
		encoding = value
	}
	bom, _ := body["hasBom"].(bool)
	data, err := encodeText(content, encoding, bom)
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > s.config.maxFileBytes {
		return nil, s.sizeError("保存")
	}
	newFile := !exists(target.absolute)
	if err := writeAndSync(target.absolute, data, os.O_WRONLY|os.O_CREATE|os.O_TRUNC); err != nil {
		return nil, err
	}
	if newFile {
		if err := inheritOwnership(target.absolute); err != nil {
			return nil, err
		}
	}
	info, err := os.Stat(target.absolute)
	if err != nil {
		return nil, err
	}
	return filePayload{target.relative, target.absolute, filepath.Base(target.absolute), content, encoding, bom, ending, isoTime(info.ModTime()), info.Size()}, nil
}

func (s *server) registerFiles(register func(string, int, endpoint)) {
	read := func(fn endpoint) endpoint {
		return func(w http.ResponseWriter, r *http.Request) (any, error) {
			s.workspaceMu.RLock()
			defer s.workspaceMu.RUnlock()
			return fn(w, r)
		}
	}
	write := func(fn endpoint) endpoint {
		return func(w http.ResponseWriter, r *http.Request) (any, error) {
			s.workspaceMu.Lock()
			defer s.workspaceMu.Unlock()
			return fn(w, r)
		}
	}
	register("GET /api/meta", 200, read(func(_ http.ResponseWriter, _ *http.Request) (any, error) { return s.meta(), nil }))
	register("POST /api/root", 200, write(func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		next, ok := body["path"].(string)
		if !ok {
			return nil, fail(400, "缺少根目录路径")
		}
		return s.setRoot(next)
	}))
	register("GET /api/tree", 200, read(func(_ http.ResponseWriter, r *http.Request) (any, error) {
		dir, err := normalizeClientPath(r.URL.Query().Get("dir"))
		if err != nil {
			return nil, err
		}
		items, err := s.readDirectory(dir)
		return map[string]any{"dir": dir, "items": items}, err
	}))
	register("GET /api/search", 200, read(func(_ http.ResponseWriter, r *http.Request) (any, error) {
		query := r.URL.Query()
		dir, err := normalizeClientPath(query.Get("dir"))
		if err != nil {
			return nil, err
		}
		limit, _ := strconv.Atoi(query.Get("limit"))
		items, err := s.search(r.Context(), query.Get("query"), dir, limit)
		return map[string]any{"query": query.Get("query"), "dir": dir, "items": items}, err
	}))
	register("GET /api/file", 200, read(func(_ http.ResponseWriter, r *http.Request) (any, error) {
		target, err := s.existingPath(r.URL.Query().Get("path"))
		if err != nil {
			return nil, err
		}
		return s.readFile(target.real, target.relative)
	}))
	register("POST /api/open-path", 200, write(func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		requested := bodyString(body, "path")
		if requested == "" {
			return nil, fail(400, "缺少 path")
		}
		if !filepath.IsAbs(requested) {
			return nil, fail(400, "path 必须是绝对路径")
		}
		real, err := filepath.EvalSymlinks(filepath.Clean(requested))
		if os.IsNotExist(err) {
			return nil, fail(404, "文件不存在")
		}
		if err != nil {
			return nil, err
		}
		if !s.allowedRoot(real) {
			return nil, fail(403, "只能打开飞牛“我的文件”目录内的文本文件")
		}
		if !inside(s.rootPath, real) {
			next := filepath.Dir(real)
			if s.config.restrictRoots {
				bases := s.allowedBases()
				sort.Slice(bases, func(i, j int) bool { return len(bases[i]) > len(bases[j]) })
				for _, base := range bases {
					if inside(base, real) {
						next = base
						break
					}
				}
			}
			if _, err := s.setRoot(next); err != nil {
				return nil, err
			}
		}
		file, err := s.readFile(real, clientPath(s.rootPath, real))
		return map[string]any{"meta": s.meta(), "file": file}, err
	}))
	register("POST /api/file/save", 200, write(s.saveFile))
	register("PUT /api/file", 200, write(s.saveFile))
	register("POST /api/file", 201, write(func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		client, ok := body["path"].(string)
		if !ok {
			return nil, fail(400, "缺少 path")
		}
		content := ""
		if value, exists := body["content"]; exists {
			content, ok = value.(string)
			if !ok {
				return nil, fail(400, "缺少 path")
			}
		}
		target, err := s.writablePath(client)
		if err != nil {
			return nil, err
		}
		if entryExists(target.absolute) {
			return nil, fail(409, "同名文件已存在")
		}
		content = normalizeLineEndings(content, saveLineEnding(target.absolute, "", content))
		if err := writeAndSync(target.absolute, []byte(content), os.O_WRONLY|os.O_CREATE|os.O_EXCL); err != nil {
			return nil, err
		}
		if err := inheritOwnership(target.absolute); err != nil {
			return nil, err
		}
		info, err := os.Stat(target.absolute)
		if err != nil {
			return nil, err
		}
		return map[string]any{"path": target.relative, "modifiedAt": isoTime(info.ModTime()), "size": info.Size()}, nil
	}))
	register("POST /api/folder", 201, write(func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		client, ok := body["path"].(string)
		if !ok {
			return nil, fail(400, "缺少 path")
		}
		target, err := s.writablePath(client)
		if err != nil {
			return nil, err
		}
		if err := os.Mkdir(target.absolute, 0777); err != nil {
			return nil, err
		}
		if err := inheritOwnership(target.absolute); err != nil {
			return nil, err
		}
		return map[string]any{"path": target.relative}, nil
	}))
	register("DELETE /api/path", 200, write(func(_ http.ResponseWriter, r *http.Request) (any, error) {
		relative, err := normalizeClientPath(r.URL.Query().Get("path"))
		if err != nil {
			return nil, err
		}
		if relative == "" {
			return nil, fail(400, "不能删除根目录")
		}
		target, err := s.existingPath(relative)
		if err != nil {
			return nil, err
		}
		if err := os.RemoveAll(target.absolute); err != nil {
			return nil, err
		}
		return map[string]any{"path": target.relative}, nil
	}))
	register("PATCH /api/path", 200, write(func(w http.ResponseWriter, r *http.Request) (any, error) {
		body, err := decodeBody(w, r)
		if err != nil {
			return nil, err
		}
		client, ok := body["path"].(string)
		next, nextOK := body["newPath"].(string)
		if !ok || !nextOK {
			return nil, fail(400, "缺少 path 或 newPath")
		}
		relative, err := normalizeClientPath(client)
		if err != nil {
			return nil, err
		}
		nextRelative, err := normalizeClientPath(next)
		if err != nil {
			return nil, err
		}
		if relative == "" || nextRelative == "" {
			return nil, fail(400, "不能重命名根目录")
		}
		target, err := s.existingPath(relative)
		if err != nil {
			return nil, err
		}
		nextTarget, err := s.writablePath(nextRelative)
		if err != nil {
			return nil, err
		}
		if entryExists(nextTarget.absolute) {
			return nil, fail(409, "目标路径已存在")
		}
		if err := os.Rename(target.absolute, nextTarget.absolute); err != nil {
			return nil, err
		}
		info, err := os.Stat(nextTarget.absolute)
		if err != nil {
			return nil, err
		}
		kind := "file"
		if info.IsDir() {
			kind = "directory"
		}
		return map[string]any{"path": nextTarget.relative, "type": kind, "modifiedAt": isoTime(info.ModTime()), "size": info.Size()}, nil
	}))
}
