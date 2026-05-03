<?php

declare(strict_types=1);

return [
    'default' => env('DB_CONNECTION', 'mysql'),
    'connections' => [
        'mysql' => [
            'driver'    => 'mysql',
            'host'      => env('DB_HOST', '127.0.0.1'),
            'port'      => env('DB_PORT', '3306'),
            'database'  => env('DB_DATABASE'),
            'username'  => env('DB_USERNAME'),
            'password'  => env('DB_PASSWORD'),
            'charset'   => 'utf8mb4',
            'collation' => 'utf8mb4_unicode_ci',
            'prefix'    => '',
            'strict'    => true,
            'engine'    => 'InnoDB',
        ],
    ],
    'migrations' => [
        'table'                  => 'migrations',
        'update_date_on_publish' => true,
    ],
    'redis' => [
        'client'  => 'predis',
        'options' => ['cluster' => 'redis', 'prefix' => 'cooltunnel:'],
        'default' => [
            'host'     => env('REDIS_HOST', '127.0.0.1'),
            'port'     => env('REDIS_PORT', '6379'),
            'password' => env('REDIS_PASSWORD'),
            'database' => 0,
        ],
        'cache' => [
            'host'     => env('REDIS_HOST', '127.0.0.1'),
            'port'     => env('REDIS_PORT', '6379'),
            'password' => env('REDIS_PASSWORD'),
            'database' => 1,
        ],
    ],
];
