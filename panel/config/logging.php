<?php

use Monolog\Handler\StreamHandler;

return [
    'default'         => env('LOG_CHANNEL', 'stack'),
    'deprecations'    => env('LOG_DEPRECATIONS_CHANNEL', 'null'),
    'channels' => [
        'stack' => [
            'driver'   => 'stack',
            'channels' => ['stderr'],
            'ignore_exceptions' => false,
        ],
        'stderr' => [
            'driver'  => 'monolog',
            'level'   => env('LOG_LEVEL', 'info'),
            'handler' => StreamHandler::class,
            'with'    => ['stream' => 'php://stderr'],
            'formatter' => env('LOG_STDERR_FORMATTER'),
        ],
        'null' => ['driver' => 'monolog', 'handler' => Monolog\Handler\NullHandler::class],
    ],
];
