{
    "log": {
        "level": "info",
        "timestamp": true,
        "disabled": false
    },

    "inbounds": [
        {
            "type": "naive",
            "tag": "naive-in",
            "listen": "::",
            "listen_port": 443,
            "users": {{ .UsersJson }},
            "tls": {
                "enabled": true,
                "server_name": "{{ .Domain }}",
                "alpn": ["h2", "http/1.1"],
                "min_version": "1.2",
                "acme": {
                    "domain": ["{{ .Domain }}"],
                    "default_server_name": "{{ .Domain }}",
                    "email": "{{ .AcmeEmail }}",
                    "provider": "{{ .AcmeDirectory }}",
                    "data_directory": "/data/acme",
                    "alternative_http_port": 80
                }
            }
        }
    ],

    "outbounds": [
        {"type": "direct", "tag": "direct"},
        {"type": "block",  "tag": "block"}
    ],

    "route": {
        "default_domain_resolver": "{{ .DohResolver }}",
        "rules": [
            {"protocol": "dns", "outbound": "block"}
        ]
    },

    "experimental": {
        "clash_api": {
            "external_controller": "127.0.0.1:9090",
            "secret": "{{ .ClashSecret }}",
            "external_controller_unix": "/run/sing-box/clash.sock"
        },
        "cache_file": {
            "enabled": true,
            "path": "/data/cache.db"
        }
    }
}
