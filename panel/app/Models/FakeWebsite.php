<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class FakeWebsite extends Model
{
    use HasFactory;

    protected $fillable = [
        'slug', 'name', 'template', 'title', 'tagline',
        'payload', 'is_active',
    ];

    protected function casts(): array
    {
        return [
            'payload'   => 'array',
            'is_active' => 'boolean',
        ];
    }

    public static function active(): ?self
    {
        return static::where('is_active', true)->first();
    }

    protected static function booted(): void
    {
        // Only one fake site can be active at a time.
        static::saved(function (self $site) {
            if ($site->is_active) {
                static::where('id', '!=', $site->id)
                    ->where('is_active', true)
                    ->update(['is_active' => false]);
            }
        });
    }
}
