<?php

declare(strict_types=1);

namespace App\Services;

// Tiny utility — generates a cleartext proxy password and the bcrypt
// hash Caddy expects. Used by ProxyAccountResource on create / regen.

final class PasswordGenerator
{
    /** Returns ['cleartext' => 'xxx', 'hash' => '$2y$...']. */
    public static function make(int $length = 24): array
    {
        // Avoid ambiguous chars (O/0, l/1) so admins can read out the
        // cleartext over the phone if they have to.
        $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
        $cleartext = '';
        for ($i = 0; $i < $length; $i++) {
            $cleartext .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        }

        return [
            'cleartext' => $cleartext,
            'hash' => password_hash($cleartext, PASSWORD_BCRYPT, ['cost' => 12]),
        ];
    }
}
