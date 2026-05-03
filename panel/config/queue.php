<?php

declare(strict_types=1);

return [
    'default' => env('QUEUE_CONNECTION', 'database'),
    'connections' => [
        'redis' => [
            'driver'      => 'redis',
            'connection'  => 'default',
            'queue'       => env('REDIS_QUEUE', 'default'),
            'retry_after' => 90,
            'block_for'   => null,
            'after_commit'=> false,
        ],
        'database' => [
            'driver'      => 'database',
            'connection'  => env('DB_CONNECTION', 'mysql'),
            'table'       => 'jobs',
            'queue'       => 'default',
            'retry_after' => 90,
        ],
    ],
    'failed' => [
        'driver'   => 'database-uuids',
        'database' => env('DB_CONNECTION', 'mysql'),
        'table'    => 'failed_jobs',
    ],
];
