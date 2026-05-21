<?php

// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

return [
    'paths' => [
        resource_path('views'),
    ],
    'compiled' => env(
        'VIEW_COMPILED_PATH',
        realpath(storage_path('framework/views')) ?: storage_path('framework/views'),
    ),
];
