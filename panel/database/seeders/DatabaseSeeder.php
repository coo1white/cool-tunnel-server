<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Models\FakeWebsite;
use App\Models\ServerConfig;
use Illuminate\Database\Seeder;

class DatabaseSeeder extends Seeder
{
    public function run(): void
    {
        // Seed the singleton ServerConfig row.
        ServerConfig::current();

        // Seed a single default cover-site. Operators can create
        // additional fake sites in the panel using any of the
        // available templates (blog / corporate / portfolio — see
        // FakeWebsiteResource's template picker); shipping just
        // one default keeps the first-login surface minimal and
        // makes "which one is live?" unambiguous.
        if (FakeWebsite::count() === 0) {
            FakeWebsite::create([
                'slug' => 'minimal-blog',
                'name' => 'Minimal Blog',
                'template' => 'blog',
                'title' => 'Notes & Drafts',
                'tagline' => 'Occasional writing about software and design.',
                'payload' => ['posts' => [
                    ['title' => 'Hello, world',  'date' => '2026-04-12', 'excerpt' => 'A first post.'],
                    ['title' => 'Half-baked ideas', 'date' => '2026-04-21', 'excerpt' => 'A list of things I want to try.'],
                    ['title' => 'On simplicity', 'date' => '2026-05-01', 'excerpt' => 'Why doing less often beats doing more.'],
                ]],
                'is_active' => true,
            ]);
        }
    }
}
