<?php

declare(strict_types=1);

return [
    'default' => env('CACHE_STORE', 'database'),
    'stores'  => [
        'redis' => [
            'driver'     => 'redis',
            'connection' => 'cache',
        ],
        'database' => [
            'driver'     => 'database',
            'connection' => env('DB_CONNECTION', 'mysql'),
            'table'      => 'cache',
        ],
        'file' => ['driver' => 'file', 'path' => storage_path('framework/cache/data')],
    ],
    'prefix' => env('CACHE_PREFIX', 'cool_tunnel_cache_'),
];
