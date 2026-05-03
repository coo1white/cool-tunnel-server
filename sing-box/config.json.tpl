{
    "log": {
        "level": "warn",
        "timestamp": true,
        "disabled": false
    },

    "dns": {
        "servers": [
            {
                "tag": "doh",
                "address": "{{ .DohResolver }}",
                "strategy": "ipv4_only"
            }
        ],
        "final": "doh"
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
                "min_version": "1.3",
                "max_version": "1.3",
                "certificate_path": "{{ .CertPath }}",
                "key_path":         "{{ .KeyPath }}"
            }
        }
    ],

    "outbounds": [
        {"type": "direct", "tag": "direct"},
        {"type": "block",  "tag": "block"}
    ],

    "route": {
        "rules": [
            {"protocol": "dns", "outbound": "block"}
        ]
    },

    "experimental": {
        "clash_api": {
            "external_controller_unix": "/run/sing-box/clash.sock",
            "secret": "{{ .ClashSecret }}"
        },
        "cache_file": {
            "enabled": false,
            "path": "/data/cache.db"
        }
    }
}
