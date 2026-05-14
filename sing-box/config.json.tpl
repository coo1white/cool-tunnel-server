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
                "type": "https",
                "server": "{{ .DohServer }}",
                "path": "{{ .DohPath }}"
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
        {
            "type": "direct",
            "tag":  "direct",
            "domain_resolver": {"server": "doh", "strategy": "ipv4_only"}
        },
        {"type": "block",  "tag": "block"}
    ],

    "route": {
        "default_domain_resolver": {"server": "doh", "strategy": "ipv4_only"},
        "rules": [
            {"protocol": "dns", "outbound": "block"}
        ]
    },

    "experimental": {
        "clash_api": {
            "external_controller": "{{ .ClashListen }}",
            "secret": "{{ .ClashSecret }}"
        },
        "cache_file": {
            "enabled": false,
            "path": "/data/cache.db"
        }
    }
}

