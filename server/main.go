package main

import (
	"compress/gzip"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// version is set by the production build; source runs read package.json.
var version = "unknown"

//go:embed open-with.html
var pages embed.FS

var openWithTemplate = template.Must(template.ParseFS(pages, "open-with.html"))

type server struct {
	config              config
	workspaceMu         sync.RWMutex
	rootPath, rootLabel string
	stateMu             sync.Mutex
	eventsMu            sync.Mutex
	debugEnabled        bool
	diagnostics         []diagnosticEvent
	coordMu             sync.Mutex
	instances           map[string]int64
	handoffs            map[string]*handoffRequest
	handoffOrder        []string
	clients             map[chan handoffRequest]struct{}
	done                chan struct{}
}

func newServer(cfg config) (*server, error) {
	s := &server{
		config: cfg, instances: make(map[string]int64), handoffs: make(map[string]*handoffRequest),
		clients: make(map[chan handoffRequest]struct{}), diagnostics: []diagnosticEvent{}, done: make(chan struct{}),
	}
	state := s.readState()
	s.debugEnabled, _ = state["debugLoggingEnabled"].(bool)
	root, err := s.resolveRoot(state)
	if err != nil {
		return nil, err
	}
	s.rootPath = root
	s.rootLabel = firstNonEmpty(os.Getenv("FNEDITOR_ROOT_LABEL"), filepath.Base(root))
	return s, nil
}

type httpError struct {
	status  int
	message string
}

func (e *httpError) Error() string          { return e.message }
func fail(status int, message string) error { return &httpError{status, message} }

type endpoint func(http.ResponseWriter, *http.Request) (any, error)

func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write response: %v", err)
	}
}

func writeError(w http.ResponseWriter, err error) {
	status, message := 500, "服务器内部错误"
	var apiError *httpError
	if errors.As(err, &apiError) {
		status, message = apiError.status, apiError.message
	} else if errors.Is(err, os.ErrPermission) {
		status, message = 403, err.Error()
	} else {
		log.Printf("request failed: %v", err)
	}
	jsonResponse(w, status, map[string]any{"error": message})
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	register := func(pattern string, status int, fn endpoint) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			payload, err := fn(w, r)
			if err != nil {
				if r.Context().Err() == nil {
					writeError(w, err)
				}
				return
			}
			if payload != nil {
				jsonResponse(w, status, payload)
			}
		})
	}
	s.registerFiles(register)
	s.registerCoordination(register)
	s.registerDiagnostics(register)
	mux.HandleFunc("GET /api/handoff/events", s.streamEvents)
	mux.HandleFunc("GET /open-with", s.openWith)
	mux.HandleFunc("/", s.serveFrontend)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		// Event streams must flush immediately and must never be compressed.
		if r.URL.Path != "/api/handoff/events" && acceptsGzip(r.Header.Get("Accept-Encoding")) {
			w.Header().Add("Vary", "Accept-Encoding")
			w.Header().Set("Content-Encoding", "gzip")
			gz := gzip.NewWriter(w)
			defer gz.Close()
			w = &gzipResponse{ResponseWriter: w, writer: gz}
		}
		mux.ServeHTTP(w, r)
	})
}

type gzipResponse struct {
	http.ResponseWriter
	writer *gzip.Writer
}

func (w *gzipResponse) WriteHeader(code int) {
	w.Header().Del("Content-Length")
	w.ResponseWriter.WriteHeader(code)
}
func (w *gzipResponse) Write(data []byte) (int, error) {
	w.Header().Del("Content-Length")
	return w.writer.Write(data)
}
func acceptsGzip(value string) bool {
	for _, part := range strings.Split(value, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if fields[0] == "gzip" {
			for _, param := range fields[1:] {
				if strings.TrimSpace(param) == "q=0" {
					return false
				}
			}
			return true
		}
	}
	return false
}

func decodeBody(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	r.Body = http.MaxBytesReader(w, r.Body, 12*1024*1024)
	decoder := json.NewDecoder(r.Body)
	var body map[string]any
	if err := decoder.Decode(&body); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, fail(413, "请求内容过大")
		}
		return nil, fail(400, "请求 JSON 格式错误")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, fail(413, "请求内容过大")
		}
		return nil, fail(400, "请求 JSON 格式错误")
	}
	return body, nil
}
func stringValue(value any) string { result, _ := value.(string); return result }
func bodyString(body map[string]any, key string) string {
	return strings.TrimSpace(stringValue(body[key]))
}

func (s *server) openWith(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	requested := ""
	for _, key := range []string{"path", "open", "file"} {
		if values, exists := query[key]; exists {
			if len(values) > 0 {
				requested = values[0]
			}
			break
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// html/template escapes the path for its JavaScript context, including </script>.
	if err := openWithTemplate.Execute(w, struct{ RequestedPath string }{requested}); err != nil {
		log.Printf("open-with: %v", err)
	}
}

func (s *server) serveFrontend(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		jsonResponse(w, 404, map[string]any{"error": "接口不存在"})
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		jsonResponse(w, 405, map[string]any{"error": "请求方法不支持"})
		return
	}
	name := filepath.Join(s.config.distPath, filepath.FromSlash(strings.TrimPrefix(r.URL.Path, "/")))
	info, err := os.Stat(name)
	if err == nil && !info.IsDir() && filepath.Ext(name) != ".html" {
		http.ServeFile(w, r, name)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	index := filepath.Join(s.config.distPath, "index.html")
	f, err := os.Open(index)
	if err != nil {
		http.Error(w, "Frontend is not built. Run npm run build first.", http.StatusServiceUnavailable)
		return
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil {
		writeError(w, err)
		return
	}
	http.ServeContent(w, r, "index.html", info.ModTime(), f)
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	s, err := newServer(cfg)
	if err != nil {
		log.Fatal(err)
	}
	httpServer := &http.Server{Addr: cfg.address, Handler: s.handler(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	shutdownDone := make(chan struct{})
	go func() {
		defer close(shutdownDone)
		<-ctx.Done()
		close(s.done)
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()
	log.Printf("fneditor listening on http://%s", cfg.address)
	log.Printf("file root: %s", s.rootPath)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
	<-shutdownDone
}
