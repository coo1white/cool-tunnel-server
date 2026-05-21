<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

return [
    'default' => env('BROADCAST_CONNECTION', 'null'),
    'connections' => [
        'null' => [
            'driver' => 'null',
        ],
        'log' => [
            'driver' => 'log',
        ],
    ],
];
