package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func testServer(t *testing.T, restricted bool) *server {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "files")
	if err := os.Mkdir(root, 0755); err != nil {
		t.Fatal(err)
	}
	cfg := config{appDir: base, distPath: filepath.Join(base, "dist"), statePath: filepath.Join(base, "state.json"), configuredRoot: root, maxFileBytes: 5 * 1024 * 1024, restrictRoots: restricted, version: "test-version"}
	s, err := newServer(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func api(t *testing.T, s *server, method, uri string, body any, status int) map[string]any {
	t.Helper()
	var input io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		input = bytes.NewReader(data)
	}
	req := httptest.NewRequest(method, uri, input)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, req)
	if rec.Code != status {
		t.Fatalf("%s %s: expected %d, got %d: %s", method, uri, status, rec.Code, rec.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("%s: %v", rec.Body.String(), err)
	}
	if status >= 400 {
		if _, ok := payload["error"].(string); !ok {
			t.Fatalf("error contract: %v", payload)
		}
	}
	return payload
}

func TestFileLifecycleAndSearch(t *testing.T) {
	s := testServer(t, false)
	meta := api(t, s, "GET", "/api/meta", nil, 200)
	if meta["version"] != "test-version" || meta["rootPath"] != s.rootPath || meta["maxFileBytes"] != float64(5*1024*1024) {
		t.Fatal(meta)
	}
	api(t, s, "POST", "/api/folder", map[string]any{"path": "folder"}, 201)
	api(t, s, "POST", "/api/file", map[string]any{"path": "folder/note.txt", "content": "first\r\nneedle 第二行\r\n"}, 201)
	api(t, s, "POST", "/api/file", map[string]any{"path": "folder/note.txt"}, 409)
	file := api(t, s, "GET", "/api/file?path=folder%2Fnote.txt", nil, 200)
	if file["encoding"] != "utf8" || file["hasBom"] != false || file["lineEnding"] != "crlf" || file["absolutePath"] != filepath.Join(s.rootPath, "folder", "note.txt") {
		t.Fatal(file)
	}
	api(t, s, "POST", "/api/file", map[string]any{"path": "file10.txt"}, 201)
	api(t, s, "POST", "/api/file", map[string]any{"path": "file2.txt"}, 201)
	tree := api(t, s, "GET", "/api/tree", nil, 200)["items"].([]any)
	for i, name := range []string{"folder", "file2.txt", "file10.txt"} {
		if tree[i].(map[string]any)["name"] != name {
			t.Fatal(tree)
		}
	}
	results := api(t, s, "GET", "/api/search?query=NEEDLE", nil, 200)["items"].([]any)
	if len(results) != 1 {
		t.Fatal(results)
	}
	match := results[0].(map[string]any)
	if match["matchedBy"] != "content" || match["line"] != float64(2) || match["preview"] != "needle 第二行" {
		t.Fatal(match)
	}
	api(t, s, "PUT", "/api/file", map[string]any{"path": "folder/note.txt", "content": "saved\ncontent", "lineEnding": "crlf"}, 200)
	data, _ := os.ReadFile(filepath.Join(s.rootPath, "folder", "note.txt"))
	if string(data) != "saved\r\ncontent" {
		t.Fatalf("bytes: %q", data)
	}
	api(t, s, "PATCH", "/api/path", map[string]any{"path": "folder", "newPath": "renamed"}, 200)
	file = api(t, s, "GET", "/api/file?path=renamed/note.txt", nil, 200)
	if file["content"] != "saved\r\ncontent" {
		t.Fatal(file)
	}
	api(t, s, "DELETE", "/api/path?path=renamed", nil, 200)
	if exists(filepath.Join(s.rootPath, "renamed")) {
		t.Fatal("directory was not deleted")
	}
	api(t, s, "PATCH", "/api/path", map[string]any{"path": "file2.txt", "newPath": "file10.txt"}, 409)
	api(t, s, "DELETE", "/api/path", nil, 400)
	api(t, s, "PATCH", "/api/path", map[string]any{"path": "", "newPath": "x"}, 400)
}

func TestTraversalAndSymlinkEscape(t *testing.T) {
	s := testServer(t, true)
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("secret"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, uri := range []string{"/api/file?path=../secret.txt", "/api/tree?dir=..%5Coutside", "/api/search?dir=..&query=secret"} {
		api(t, s, "GET", uri, nil, 400)
	}
	api(t, s, "POST", "/api/file", map[string]any{"path": "../escape.txt"}, 400)
	api(t, s, "POST", "/api/file/save", map[string]any{"path": "secret.txt", "absolutePath": secret, "content": "changed"}, 403)
	api(t, s, "POST", "/api/open-path", map[string]any{"path": secret}, 403)
	api(t, s, "POST", "/api/root", map[string]any{"path": outside}, 403)
	if err := os.Symlink(outside, filepath.Join(s.rootPath, "outside")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if err := os.Symlink(secret, filepath.Join(s.rootPath, "secret-link")); err != nil {
		t.Fatal(err)
	}
	api(t, s, "GET", "/api/file?path=secret-link", nil, 403)
	api(t, s, "GET", "/api/tree?dir=outside", nil, 403)
	api(t, s, "POST", "/api/file", map[string]any{"path": "outside/new.txt"}, 403)
	api(t, s, "POST", "/api/file/save", map[string]any{"path": "secret-link", "content": "changed"}, 403)
	api(t, s, "DELETE", "/api/path?path=outside", nil, 403)
	api(t, s, "PATCH", "/api/path", map[string]any{"path": "secret-link", "newPath": "x"}, 403)
	tree := api(t, s, "GET", "/api/tree", nil, 200)["items"].([]any)
	if len(tree) != 0 {
		t.Fatal(tree)
	}
	results := api(t, s, "GET", "/api/search?query=secret", nil, 200)["items"].([]any)
	if len(results) != 0 {
		t.Fatal(results)
	}
	data, _ := os.ReadFile(secret)
	if string(data) != "secret" {
		t.Fatal("outside file changed")
	}
}

func TestLimitsAndBinaryRejection(t *testing.T) {
	s := testServer(t, false)
	s.config.maxFileBytes = 8
	if err := os.WriteFile(filepath.Join(s.rootPath, "large.txt"), []byte("123456789"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.rootPath, "binary.dat"), []byte{0, 1, 2, 3}, 0644); err != nil {
		t.Fatal(err)
	}
	api(t, s, "GET", "/api/file?path=large.txt", nil, 413)
	api(t, s, "GET", "/api/file?path=binary.dat", nil, 415)
	api(t, s, "GET", "/api/file", nil, 400)
	api(t, s, "POST", "/api/file/save", map[string]any{"path": "x", "content": "12345", "encoding": "utf16le"}, 413)
	if exists(filepath.Join(s.rootPath, "x")) {
		t.Fatal("oversized save created file")
	}
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, httptest.NewRequest("POST", "/api/root", strings.NewReader(`{"path":"x"} garbage`)))
	if rec.Code != 400 {
		t.Fatal(rec.Code, rec.Body.String())
	}
}

func TestRootPersistenceAndAbsoluteSave(t *testing.T) {
	s := testServer(t, false)
	oldRoot := s.rootPath
	api(t, s, "POST", "/api/file", map[string]any{"path": "old.txt", "content": "old"}, 201)
	next := t.TempDir()
	target := filepath.Join(next, "new.txt")
	os.WriteFile(target, []byte("new"), 0644)
	opened := api(t, s, "POST", "/api/open-path", map[string]any{"path": target}, 200)
	if opened["meta"].(map[string]any)["rootPath"] != next || opened["file"].(map[string]any)["path"] != "new.txt" {
		t.Fatal(opened)
	}
	// An open tab can still save its absolute file after the workspace changes.
	api(t, s, "POST", "/api/file/save", map[string]any{"path": "old.txt", "absolutePath": filepath.Join(oldRoot, "old.txt"), "content": "saved"}, 200)
	data, _ := os.ReadFile(filepath.Join(oldRoot, "old.txt"))
	if string(data) != "saved" {
		t.Fatal(string(data))
	}
	api(t, s, "PUT", "/api/diagnostics/settings", map[string]any{"enabled": true}, 200)
	restarted, err := newServer(s.config)
	if err != nil {
		t.Fatal(err)
	}
	meta := api(t, restarted, "GET", "/api/meta", nil, 200)
	if meta["rootPath"] != next || meta["debugLoggingEnabled"] != true {
		t.Fatal(meta)
	}
	api(t, s, "POST", "/api/root", map[string]any{"path": string(filepath.Separator)}, 400)
}

func TestCoordinationAndSSE(t *testing.T) {
	s := testServer(t, false)
	api(t, s, "POST", "/api/instances/claim", map[string]any{"id": "primary"}, 200)
	claim := api(t, s, "POST", "/api/instances/claim", map[string]any{"id": "secondary"}, 200)
	if claim["active"] != true || claim["id"] != "primary" {
		t.Fatal(claim)
	}
	api(t, s, "POST", "/api/instances/heartbeat", map[string]any{"id": "primary"}, 200)
	primary := api(t, s, "GET", "/api/instances/primary?sourceId=secondary", nil, 200)
	if primary["id"] != "primary" {
		t.Fatal(primary)
	}
	httpServer := httptest.NewServer(s.handler())
	defer httpServer.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", httpServer.URL+"/api/handoff/events", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Content-Type") != "text/event-stream" || response.Header.Get("Content-Encoding") != "" {
		t.Fatal(response.Header)
	}
	reader := bufio.NewReader(response.Body)
	readEvent := func() (string, map[string]any) {
		t.Helper()
		name, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		data, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if _, err := reader.ReadString('\n'); err != nil {
			t.Fatal(err)
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(strings.TrimPrefix(strings.TrimSpace(data), "data: ")), &payload); err != nil {
			t.Fatal(err)
		}
		return strings.TrimSpace(strings.TrimPrefix(name, "event: ")), payload
	}
	name, _ := readEvent()
	if name != "ready" {
		t.Fatal(name)
	}
	api(t, s, "POST", "/api/handoff/open", map[string]any{"id": "request", "sourceId": "secondary", "path": "/example.txt", "createdAt": time.Now().UnixMilli()}, 200)
	name, event := readEvent()
	if name != "open-file" || event["id"] != "request" || event["acknowledged"] != false {
		t.Fatal(name, event)
	}
	pending := api(t, s, "GET", "/api/handoff/pending?sourceId=primary", nil, 200)["items"].([]any)
	if len(pending) != 1 {
		t.Fatal(pending)
	}
	pending = api(t, s, "GET", "/api/handoff/pending?sourceId=secondary", nil, 200)["items"].([]any)
	if len(pending) != 0 {
		t.Fatal(pending)
	}
	api(t, s, "POST", "/api/handoff/ack", map[string]any{"id": "request"}, 200)
	status := api(t, s, "GET", "/api/handoff/status?id=request", nil, 200)
	if status["acknowledged"] != true {
		t.Fatal(status)
	}
	api(t, s, "POST", "/api/instances/release", map[string]any{"id": "primary"}, 200)
	primary = api(t, s, "GET", "/api/instances/primary", nil, 200)
	if primary["active"] != false {
		t.Fatal(primary)
	}
	api(t, s, "POST", "/api/instances/heartbeat", map[string]any{"id": "stale"}, 200)
	s.coordMu.Lock()
	s.instances["stale"] = time.Now().UnixMilli() - instanceTTL - 1
	s.handoffs["request"].CreatedAt = time.Now().UnixMilli() - handoffTTL - 1
	s.coordMu.Unlock()
	primary = api(t, s, "GET", "/api/instances/primary", nil, 200)
	if primary["active"] != false {
		t.Fatal(primary)
	}
	status = api(t, s, "GET", "/api/handoff/status?id=request", nil, 200)
	if status["acknowledged"] != false {
		t.Fatal(status)
	}
}

func TestConcurrentClaimsAndStateUpdates(t *testing.T) {
	s := testServer(t, false)
	var wg sync.WaitGroup
	claims := make(chan bool, 20)
	errors := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			data, _ := json.Marshal(map[string]any{"id": fmt.Sprint(i)})
			rec := httptest.NewRecorder()
			s.handler().ServeHTTP(rec, httptest.NewRequest("POST", "/api/instances/claim", bytes.NewReader(data)))
			var claim struct{ Active bool }
			err := json.Unmarshal(rec.Body.Bytes(), &claim)
			if rec.Code != 200 || err != nil {
				errors <- fmt.Errorf("claim: %d %v", rec.Code, err)
				return
			}
			claims <- claim.Active
		}(i)
	}
	wg.Wait()
	close(claims)
	close(errors)
	for err := range errors {
		t.Error(err)
	}
	newPrimaries := 0
	for active := range claims {
		if !active {
			newPrimaries++
		}
	}
	if newPrimaries != 1 {
		t.Fatalf("got %d primary instances", newPrimaries)
	}
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := s.updateState(map[string]any{fmt.Sprint(i): i}); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	state := s.readState()
	for i := 0; i < 20; i++ {
		if state[fmt.Sprint(i)] != float64(i) {
			t.Fatal(state)
		}
	}
}

func TestDiagnosticsAndOpenWithEscaping(t *testing.T) {
	s := testServer(t, false)
	posted := api(t, s, "POST", "/api/diagnostics/events", map[string]any{"source": "test", "event": "disabled"}, 200)
	if posted["recorded"] != false {
		t.Fatal(posted)
	}
	api(t, s, "PUT", "/api/diagnostics/settings", map[string]any{"enabled": "on"}, 200)
	api(t, s, "POST", "/api/diagnostics/events", map[string]any{"source": "test", "event": "enabled", "data": map[string]any{"value": strings.Repeat("x", 900)}}, 200)
	for i := 0; i < 805; i++ {
		s.diagnostic("test", "limit", map[string]any{"i": i})
	}
	items := api(t, s, "GET", "/api/diagnostics/events", nil, 200)["items"].([]any)
	if len(items) != 800 {
		t.Fatal(len(items))
	}
	rec := httptest.NewRecorder()
	s.handler().ServeHTTP(rec, httptest.NewRequest("GET", "/api/diagnostics/events.txt", nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "test limit") {
		t.Fatal(rec.Body.String())
	}
	api(t, s, "DELETE", "/api/diagnostics/events", nil, 200)
	if items := api(t, s, "GET", "/api/diagnostics/events", nil, 200)["items"].([]any); len(items) != 0 {
		t.Fatal(items)
	}
	malicious := `</script><script>alert("x")</script>`
	rec = httptest.NewRecorder()
	s.handler().ServeHTTP(rec, httptest.NewRequest("GET", "/open-with?path="+url.QueryEscape(malicious), nil))
	if rec.Code != 200 || strings.Contains(rec.Body.String(), malicious) || !strings.Contains(rec.Body.String(), `\u003c/script\u003e`) {
		t.Fatal(rec.Body.String())
	}
}

func TestFrontendAndGzip(t *testing.T) {
	s := testServer(t, false)
	if err := os.MkdirAll(filepath.Join(s.config.distPath, "assets"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.config.distPath, "index.html"), []byte("<!doctype html><title>editor</title>"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.config.distPath, "assets", "app.js"), []byte("console.log('editor')"), 0644); err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(s.handler())
	defer httpServer.Close()
	for _, uri := range []string{"/", "/nested/editor", "/index.html", "/assets/app.js", "/api/meta"} {
		req, _ := http.NewRequest("GET", httpServer.URL+uri, nil)
		req.Header.Set("Accept-Encoding", "gzip")
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		reader, err := gzip.NewReader(response.Body)
		if err != nil {
			response.Body.Close()
			t.Fatal(uri, err)
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		response.Body.Close()
		if err != nil {
			t.Fatal(uri, err)
		}
		if response.StatusCode != 200 || response.Header.Get("Content-Encoding") != "gzip" {
			t.Fatal(uri, response.Status, response.Header)
		}
		if uri == "/api/meta" {
			var meta map[string]any
			if err := json.Unmarshal(data, &meta); err != nil {
				t.Fatal(string(data), err)
			}
		} else if uri == "/assets/app.js" {
			if string(data) != "console.log('editor')" {
				t.Fatal(string(data))
			}
		} else if string(data) != "<!doctype html><title>editor</title>" || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal(uri, string(data), response.Header)
		}
	}
}
