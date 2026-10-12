#!/bin/bash

cgi_name="index.cgi"
target_url="http://127.0.0.1:${FNCODE_PORT:-${FNEDITOR_PORT:-${TRIM_SERVICE_PORT:-39280}}}"

if [[ "$REQUEST_URI" == *"$cgi_name"* ]]; then
    after_proxy="${REQUEST_URI#*$cgi_name}"

    if [[ "$after_proxy" == *"?"* ]]; then
        target_path=$(echo "$after_proxy" | cut -d'?' -f1)
        target_query=$(echo "$after_proxy" | cut -d'?' -f2-)
    else
        target_path="$after_proxy"
        target_query=""
    fi
else
    target_path=""
    target_query="$QUERY_STRING"
fi

if [ -z "$target_path" ]; then
    target_path="/"
fi

target_url="$target_url$target_path"
if [ -n "$target_query" ]; then
    target_url="$target_url?$target_query"
fi

curl_args=(--silent --show-error --include --no-buffer --http1.1 -X "${REQUEST_METHOD:-GET}")

if [ -n "$HTTP_COOKIE" ]; then
    curl_args+=(-H "Cookie: $HTTP_COOKIE")
fi
if [ -n "$CONTENT_TYPE" ]; then
    curl_args+=(-H "Content-Type: $CONTENT_TYPE")
fi
curl_args+=("$target_url")

# CGI requires a Status header rather than an HTTP response status line.
# Parse headers only; copying the body with cat preserves binary assets and SSE.
forward_response() {
    local status_line header status_code
    local -a response_headers

    while IFS= read -r status_line; do
        status_line="${status_line%$'\r'}"
        if [[ ! "$status_line" =~ ^HTTP/[0-9.]+\ ([0-9]{3})(\ |$) ]]; then
            break
        fi
        status_code="${BASH_REMATCH[1]}"
        response_headers=()
        while IFS= read -r header; do
            header="${header%$'\r'}"
            [ -n "$header" ] || break
            case "${header,,}" in
                transfer-encoding:*|connection:*|keep-alive:*) ;;
                *) response_headers+=("$header") ;;
            esac
        done
        # curl can include interim responses, such as 100 Continue.
        if [[ "$status_code" == 1* ]]; then
            continue
        fi

        printf 'Status: %s\r\n' "${status_line#* }"
        for header in "${response_headers[@]}"; do
            printf '%s\r\n' "$header"
        done
        printf '\r\n'
        cat
        return
    done

    printf 'Status: 502 Bad Gateway\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'
    printf '{"error":"无法连接编辑器服务，请检查服务是否已启动"}\n'
}

case "${REQUEST_METHOD:-GET}" in
    POST|PUT|PATCH)
        curl "${curl_args[@]}" --data-binary @- | forward_response
        ;;
    *)
        curl "${curl_args[@]}" | forward_response
        ;;
esac
