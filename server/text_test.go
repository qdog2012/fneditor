package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/text/encoding/simplifiedchinese"
)

func TestEncodingReadSaveRoundTrips(t *testing.T) {
	// Known bytes validate detection independently of the backend encoder.
	fixtures := []struct {
		name, encoding string
		bom            bool
		data           []byte
		content        string
	}{
		{"utf8", "utf8", false, []byte("你好\r\nworld\r\n"), "你好\r\nworld\r\n"},
		{"utf8-bom", "utf8", true, append([]byte{0xef, 0xbb, 0xbf}, []byte("你好\r\n")...), "你好\r\n"},
		{"utf8-replacement", "utf8", false, []byte("������������\r\n"), "������������\r\n"},
		{"utf16le", "utf16le", false, []byte{'A', 0, 'B', 0, 'C', 0, 'D', 0, '\r', 0, '\n', 0}, "ABCD\r\n"},
		{"utf16le-bom", "utf16le", true, []byte{0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59, 13, 0, 10, 0}, "你好\r\n"},
		{"utf16le-replacement", "utf16le", true, []byte{0xff, 0xfe, 0xfd, 0xff, 13, 0, 10, 0}, "�\r\n"},
		{"utf16le-surrogates", "utf16le", true, []byte{0xff, 0xfe, 0x3d, 0xd8, 0x42, 0xde, 13, 0, 10, 0}, "🙂\r\n"},
		{"utf16be", "utf16be", false, []byte{0, 'A', 0, 'B', 0, 'C', 0, 'D', 0, '\r', 0, '\n'}, "ABCD\r\n"},
		{"utf16be-bom", "utf16be", true, []byte{0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d, 0, 13, 0, 10}, "你好\r\n"},
		{"utf16be-replacement", "utf16be", true, []byte{0xfe, 0xff, 0xff, 0xfd, 0, 13, 0, 10}, "�\r\n"},
		{"gb18030", "gb18030", false, []byte{0xc4, 0xe3, 0xba, 0xc3, 13, 10}, "你好\r\n"},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			s := testServer(t, false)
			target := filepath.Join(s.rootPath, fixture.name+".txt")
			if err := os.WriteFile(target, fixture.data, 0644); err != nil {
				t.Fatal(err)
			}
			file := api(t, s, "GET", "/api/file?path="+fixture.name+".txt", nil, 200)
			if file["content"] != fixture.content || file["encoding"] != fixture.encoding || file["hasBom"] != fixture.bom || file["lineEnding"] != "crlf" {
				t.Fatal(file)
			}
			file["content"] = strings.ReplaceAll(fixture.content, "\r\n", "\n")
			api(t, s, "POST", "/api/file/save", file, 200)
			saved, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(saved, fixture.data) {
				t.Fatalf("got %x want %x", saved, fixture.data)
			}
		})
	}
	// A four-byte GB18030 character must survive search, read, and save.
	encoded, err := simplifiedchinese.GB18030.NewEncoder().Bytes([]byte("字符🙂\n"))
	if err != nil {
		t.Fatal(err)
	}
	s := testServer(t, false)
	os.WriteFile(filepath.Join(s.rootPath, "emoji.txt"), encoded, 0644)
	file := api(t, s, "GET", "/api/file?path=emoji.txt", nil, 200)
	if file["content"] != "字符🙂\n" {
		t.Fatal(file)
	}
	api(t, s, "POST", "/api/file/save", file, 200)
	data, _ := os.ReadFile(filepath.Join(s.rootPath, "emoji.txt"))
	if !bytes.Equal(data, encoded) {
		t.Fatal(data)
	}
	items := api(t, s, "GET", "/api/search?query=字符", nil, 200)["items"].([]any)
	if len(items) != 1 {
		t.Fatal(items)
	}
}

func TestDecodeTextRejectsMalformedEncodingAndBinary(t *testing.T) {
	for _, fixture := range []struct {
		name string
		data []byte
	}{
		{"binary", []byte{0, 1, 2, 3}},
		{"control-characters", bytes.Repeat([]byte{1}, 20)},
		{"utf8-bom-invalid", []byte{0xef, 0xbb, 0xbf, 0xff}},
		{"gb18030-incomplete", []byte{0x81}},
		{"utf16le-odd-length", []byte{0xff, 0xfe, 'a'}},
		{"utf16be-odd-length", []byte{0xfe, 0xff, 'a'}},
		{"utf16le-unpaired-high", []byte{0xff, 0xfe, 0, 0xd8}},
		{"utf16be-unpaired-low", []byte{0xfe, 0xff, 0xdc, 0}},
		{"utf16le-mismatched-pair", []byte{0xff, 0xfe, 0, 0xd8, 'a', 0}},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			if content, ok := decodeText(fixture.data); ok {
				t.Fatalf("accepted malformed or binary data: %+v", content)
			}
		})
	}
}

func TestLFOnlyFilesAndExplicitLineEndings(t *testing.T) {
	s := testServer(t, false)
	for _, name := range []string{"script.sh", ".env.local", "Dockerfile", "app.service", "shebang.txt"} {
		content := "one\r\ntwo\r\n"
		if name == "shebang.txt" {
			content = "#!/bin/sh\r\necho ok\r\n"
		}
		payload := api(t, s, "POST", "/api/file/save", map[string]any{"path": name, "content": content, "lineEnding": "crlf"}, 200)
		data, _ := os.ReadFile(filepath.Join(s.rootPath, name))
		if bytes.Contains(data, []byte{'\r'}) || payload["lineEnding"] != "lf" {
			t.Fatal(name, string(data), payload)
		}
	}
	api(t, s, "POST", "/api/file/save", map[string]any{"path": "classic.txt", "content": "one\ntwo", "lineEnding": "cr"}, 200)
	file := api(t, s, "GET", "/api/file?path=classic.txt", nil, 200)
	if file["content"] != "one\rtwo" || file["lineEnding"] != "cr" {
		t.Fatal(file)
	}
}
