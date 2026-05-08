<?php
// SPDX-License-Identifier: AGPL-3.0-only

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class TrafficLog extends Model
{
    protected $fillable = [
        'proxy_account_id', 'day',
        'uplink_bytes', 'downlink_bytes', 'connections',
    ];

    protected function casts(): array
    {
        return [
            'day' => 'date',
            'uplink_bytes' => 'integer',
            'downlink_bytes' => 'integer',
            'connections' => 'integer',
        ];
    }

    public function proxyAccount(): BelongsTo
    {
        return $this->belongsTo(ProxyAccount::class);
    }

    public function totalBytes(): int
    {
        return $this->uplink_bytes + $this->downlink_bytes;
    }
}
