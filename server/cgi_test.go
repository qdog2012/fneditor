package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func runCGI(t *testing.T, target, method, uri string, body []byte) (textproto.MIMEHeader, []byte) {
	t.Helper()
	for _, tool := range []string{"bash", "curl"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("CGI test requires %s", tool)
		}
	}
	port := target[strings.LastIndex(target, ":")+1:]
	cmd := exec.Command("bash", "../packaging/fpk-native/app/ui/index.cgi")
	// Ignore inherited port overrides so each test uses its own HTTP listener.
	for _, entry := range os.Environ() {
		if !strings.HasPrefix(entry, "FNCODE_PORT=") && !strings.HasPrefix(entry, "FNEDITOR_PORT=") && !strings.HasPrefix(entry, "TRIM_SERVICE_PORT=") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	cmd.Env = append(cmd.Env, "FNEDITOR_PORT="+port, "REQUEST_METHOD="+method, "REQUEST_URI=/fncode/index.cgi"+uri,
		"CONTENT_TYPE=application/json", fmt.Sprintf("CONTENT_LENGTH=%d", len(body)), "QUERY_STRING=")
	cmd.Stdin = bytes.NewReader(body)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		t.Fatalf("CGI failed: %v: %s", err, stderr.String())
	}
	reader := bufio.NewReader(bytes.NewReader(output))
	headers, err := textproto.NewReader(reader).ReadMIMEHeader()
	if err != nil {
		t.Fatalf("invalid CGI headers: %v; output %q", err, output)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	return headers, data
}

func TestCGIPreservesOpenPathStatus(t *testing.T) {
	s := testServer(t, true)
	s.config.maxFileBytes = 8
	for name, data := range map[string][]byte{"valid.txt": []byte("hello"), "binary.dat": {0, 1, 2, 3}, "large.txt": []byte("123456789")} {
		if err := os.WriteFile(filepath.Join(s.rootPath, name), data, 0644); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret"), 0644); err != nil {
		t.Fatal(err)
	}
	backend := httptest.NewServer(s.handler())
	defer backend.Close()
	for _, tc := range []struct {
		name, requested string
		status          int
		message         string
	}{
		{"valid", filepath.Join(s.rootPath, "valid.txt"), 200, ""},
		{"missing", filepath.Join(s.rootPath, "missing.txt"), 404, "文件不存在"},
		{"binary", filepath.Join(s.rootPath, "binary.dat"), 415, "二进制文件暂不支持直接编辑"},
		{"large", filepath.Join(s.rootPath, "large.txt"), 413, "已阻止打开"},
		{"disallowed", outside, 403, "只能打开飞牛"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]any{"path": tc.requested})
			headers, data := runCGI(t, backend.URL, "POST", "/api/open-path", body)
			if !strings.HasPrefix(headers.Get("Status"), fmt.Sprint(tc.status)+" ") {
				t.Fatalf("status: %v, body: %s", headers, data)
			}
			var payload map[string]any
			if err := json.Unmarshal(data, &payload); err != nil {
				t.Fatal(err, string(data))
			}
			if tc.status == 200 {
				file, ok := payload["file"].(map[string]any)
				if !ok || file["path"] != "valid.txt" || file["content"] != "hello" {
					t.Fatal(payload)
				}
			} else if message, ok := payload["error"].(string); !ok || !strings.Contains(message, tc.message) {
				t.Fatal(payload)
			}
		})
	}
}

func TestCGISkipsInterimHeadersAndPreservesBody(t *testing.T) {
	body := []byte("HTTP/1.1 415 is body text\r\n\x00\xff\n")
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusContinue)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write(body)
	}))
	defer backend.Close()
	headers, data := runCGI(t, backend.URL, "GET", "/asset", nil)
	if headers.Get("Status") != "202 Accepted" || headers.Get("Content-Type") != "application/octet-stream" {
		t.Fatal(headers)
	}
	if headers.Get("Transfer-Encoding") != "" || headers.Get("Connection") != "" {
		t.Fatal(headers)
	}
	if !bytes.Equal(body, data) {
		t.Fatalf("body changed: %q", data)
	}
}

func TestCGIOpensSmallShellScripts(t *testing.T) {
	const script = "#!/bin/bash\nset -e\n\nif ! command -v code >/dev/null 2>&1; then\n    echo \"警告VS Code 未安装或 code 命令不可用\"\n    exit 1\nfi\n"
	garbled := strings.Replace(script, "警告VS Code 未安装或 code 命令不可用", "����VS Code δ��װ�� code �������", 1)
	gbk, err := simplifiedchinese.GBK.NewEncoder().Bytes([]byte(script))
	if err != nil {
		t.Fatal(err)
	}
	for _, fixture := range []struct {
		name, content, encoding string
		data                    []byte
	}{
		{"utf8", script, "utf8", []byte(script)},
		{"gbk", script, "gb18030", gbk},
		{"utf8-garbled", garbled, "utf8", []byte(garbled)},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			s := testServer(t, true)
			target := filepath.Join(s.rootPath, "docker", "vscode", "docker", "start.sh")
			if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, fixture.data, 0644); err != nil {
				t.Fatal(err)
			}
			backend := httptest.NewServer(s.handler())
			defer backend.Close()
			body, _ := json.Marshal(map[string]any{"path": target})
			headers, data := runCGI(t, backend.URL, "POST", "/api/open-path", body)
			if headers.Get("Status") != "200 OK" {
				t.Fatalf("open script: %v, %s", headers, data)
			}
			var payload struct {
				File filePayload `json:"file"`
			}
			if err := json.Unmarshal(data, &payload); err != nil {
				t.Fatal(err)
			}
			if payload.File.Path != "docker/vscode/docker/start.sh" || payload.File.Content != fixture.content || payload.File.Encoding != fixture.encoding {
				t.Fatalf("unexpected file payload: %+v", payload.File)
			}
			body, _ = json.Marshal(payload.File)
			headers, data = runCGI(t, backend.URL, "POST", "/api/file/save", body)
			if headers.Get("Status") != "200 OK" {
				t.Fatalf("save script: %v, %s", headers, data)
			}
			saved, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(saved, fixture.data) {
				t.Fatal("saving changed script bytes")
			}
		})
	}
}
