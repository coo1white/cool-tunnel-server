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
            "users": __USERS_BLOCK__,
            "tls": {
                "enabled": true,
                "server_name": "__DOMAIN__",
                "alpn": ["h2", "http/1.1"],
                "min_version": "1.2",
                "acme": {
                    "domain": ["__DOMAIN__"],
                    "default_server_name": "__DOMAIN__",
                    "email": "__ACME_EMAIL__",
                    "provider": "__ACME_DIRECTORY__",
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
        "default_domain_resolver": "__DOH_RESOLVER__",
        "rules": [
            {"protocol": "dns", "outbound": "block"}
        ]
    },

    "experimental": {
        "clash_api": {
            "external_controller": "127.0.0.1:9090",
            "secret": "__CLASH_SECRET__",
            "external_controller_unix": "/run/sing-box/clash.sock"
        },
        "cache_file": {
            "enabled": true,
            "path": "/data/cache.db"
        }
    }
}
