package main

import (
	"bytes"
	"encoding/binary"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

type textContent struct {
	content, encoding string
	hasBom            bool
}

func likelyText(content string) bool {
	count, suspicious := 0, 0
	for _, char := range content {
		if count >= 4096 {
			break
		}
		count++
		// A literal replacement character is valid text; decoding validity is
		// checked separately so garbled text is not mistaken for binary data.
		if char == 0 || (char < 32 && char != '\t' && char != '\n' && char != '\f' && char != '\r') {
			suspicious++
		}
	}
	return count == 0 || (suspicious <= 8 && float64(suspicious)/float64(count) < 0.02)
}

func decodeText(data []byte) (textContent, bool) {
	encoding, bom := "utf8", false
	switch {
	case bytes.HasPrefix(data, []byte{0xef, 0xbb, 0xbf}):
		bom = true
		data = data[3:]
	case bytes.HasPrefix(data, []byte{0xff, 0xfe}):
		encoding, bom, data = "utf16le", true, data[2:]
	case bytes.HasPrefix(data, []byte{0xfe, 0xff}):
		encoding, bom, data = "utf16be", true, data[2:]
	default:
		even, odd, nul := 0, 0, 0
		size := min(len(data), 4096)
		for i, value := range data[:size] {
			if value == 0 {
				nul++
				if i%2 == 0 {
					even++
				} else {
					odd++
				}
			}
		}
		pairs := size / 2
		if pairs >= 4 && float64(odd)/float64(pairs) > .35 && float64(even)/float64(pairs) < .12 {
			encoding = "utf16le"
		} else if pairs >= 4 && float64(even)/float64(pairs) > .35 && float64(odd)/float64(pairs) < .12 {
			encoding = "utf16be"
		} else if nul > 0 {
			return textContent{}, false
		} else if !utf8.Valid(data) {
			encoding = "gb18030"
		}
	}
	var content string
	switch encoding {
	case "utf16le", "utf16be":
		if len(data)%2 != 0 {
			return textContent{}, false
		}
		units := make([]uint16, len(data)/2)
		for i := range units {
			if encoding == "utf16le" {
				units[i] = binary.LittleEndian.Uint16(data[i*2:])
			} else {
				units[i] = binary.BigEndian.Uint16(data[i*2:])
			}
		}
		// Reject malformed surrogates rather than silently replacing them and
		// changing the original bytes when the file is saved.
		for i := 0; i < len(units); i++ {
			unit := units[i]
			if unit >= 0xd800 && unit <= 0xdbff {
				if i+1 >= len(units) || units[i+1] < 0xdc00 || units[i+1] > 0xdfff {
					return textContent{}, false
				}
				i++
			} else if unit >= 0xdc00 && unit <= 0xdfff {
				return textContent{}, false
			}
		}
		content = string(utf16.Decode(units))
	case "gb18030":
		decoded, err := simplifiedchinese.GB18030.NewDecoder().Bytes(data)
		if err != nil || bytes.Contains(decoded, []byte(string(utf8.RuneError))) {
			return textContent{}, false
		}
		content = string(decoded)
	default:
		if !utf8.Valid(data) {
			return textContent{}, false
		}
		content = string(data)
	}
	content = strings.TrimPrefix(content, "\ufeff")
	if !likelyText(content) {
		return textContent{}, false
	}
	return textContent{content, encoding, bom}, true
}

func encodeText(content, encoding string, bom bool) ([]byte, error) {
	switch encoding {
	case "utf16le", "utf16be":
		units := utf16.Encode([]rune(content))
		if bom {
			units = append([]uint16{0xfeff}, units...)
		}
		data := make([]byte, len(units)*2)
		for i, unit := range units {
			if encoding == "utf16le" {
				binary.LittleEndian.PutUint16(data[i*2:], unit)
			} else {
				binary.BigEndian.PutUint16(data[i*2:], unit)
			}
		}
		return data, nil
	case "gb18030", "gbk", "gb2312":
		return simplifiedchinese.GB18030.NewEncoder().Bytes([]byte(content))
	default:
		if bom {
			return append([]byte{0xef, 0xbb, 0xbf}, []byte(content)...), nil
		}
		return []byte(content), nil
	}
}

func detectLineEnding(content string) string {
	crlf := strings.Count(content, "\r\n")
	remaining := strings.ReplaceAll(content, "\r\n", "")
	lf, cr := strings.Count(remaining, "\n"), strings.Count(remaining, "\r")
	if crlf+lf+cr == 0 {
		return "lf"
	}
	if crlf >= lf && crlf >= cr {
		return "crlf"
	}
	if lf >= cr {
		return "lf"
	}
	return "cr"
}

func usesLF(name, content string) bool {
	if strings.HasPrefix(content, "#!") {
		return true
	}
	name = strings.ToLower(strings.ReplaceAll(name, "\\", "/"))
	name = name[strings.LastIndex(name, "/")+1:]
	if strings.HasPrefix(name, ".env") {
		return true
	}
	switch name {
	case "dockerfile", "makefile", "rakefile", "gemfile", "procfile":
		return true
	}
	extension := name[strings.LastIndex(name, ".")+1:]
	switch extension {
	case "sh", "bash", "zsh", "fish", "ksh", "csh", "env", "service", "timer", "socket", "mount", "automount", "target", "path":
		return true
	}
	return false
}

func saveLineEnding(name, requested, content string) string {
	if usesLF(name, content) {
		return "lf"
	}
	if requested == "lf" || requested == "crlf" || requested == "cr" {
		return requested
	}
	return detectLineEnding(content)
}
func normalizeLineEndings(content, ending string) string {
	content = strings.ReplaceAll(strings.ReplaceAll(content, "\r\n", "\n"), "\r", "\n")
	switch ending {
	case "crlf":
		return strings.ReplaceAll(content, "\n", "\r\n")
	case "cr":
		return strings.ReplaceAll(content, "\n", "\r")
	}
	return content
}
