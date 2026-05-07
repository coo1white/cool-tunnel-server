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
        //
        // Seed payload — 12 posts with monthly cadence over 2025–2026.
        // v0.0.57 china-readiness bumped this from 3 to 12: a probe
        // doing manual inspection on a 3-post site sees an obvious
        // stub; a 12-post archive with monthly cadence over a year
        // looks like a real low-volume personal blog. Excerpts are
        // generic enough to not match any real published content
        // (avoiding "this looks copy-pasted" red flags) while
        // staying topical for a "software and design" blog. Per-
        // post body / archive / RSS endpoints are a v0.0.58
        // follow-up; for now the home page is the surface a probe
        // sees.
        if (FakeWebsite::count() === 0) {
            FakeWebsite::create([
                'slug' => 'minimal-blog',
                'name' => 'Minimal Blog',
                'template' => 'blog',
                'title' => 'Notes & Drafts',
                'tagline' => 'Occasional writing about software and design.',
                'payload' => ['posts' => [
                    ['title' => 'On simplicity',         'date' => '2026-05-01', 'excerpt' => 'Why doing less often beats doing more.'],
                    ['title' => 'Half-baked ideas',      'date' => '2026-04-21', 'excerpt' => 'A list of things I want to try.'],
                    ['title' => 'Hello, world',          'date' => '2026-04-12', 'excerpt' => 'A first post.'],
                    ['title' => 'Naming things',         'date' => '2026-03-08', 'excerpt' => 'The bicycle-shed nature of variable names.'],
                    ['title' => 'Three months of tools', 'date' => '2026-02-04', 'excerpt' => 'Notes on the editor / shell / window-manager swap.'],
                    ['title' => 'A short list',          'date' => '2026-01-15', 'excerpt' => 'Five small things that improved my January.'],
                    ['title' => 'Year-end reading',      'date' => '2025-12-22', 'excerpt' => 'Books I came back to in 2025.'],
                    ['title' => 'Side projects',         'date' => '2025-11-09', 'excerpt' => 'Why I keep starting them and rarely finish.'],
                    ['title' => 'Notes on focus',        'date' => '2025-10-03', 'excerpt' => 'Things that work for me and things that don\'t.'],
                    ['title' => 'On working remotely',   'date' => '2025-08-17', 'excerpt' => 'A year in, the small adjustments that mattered.'],
                    ['title' => 'A quieter desk',        'date' => '2025-06-30', 'excerpt' => 'Removing things from my workspace, one by one.'],
                    ['title' => 'The first week',        'date' => '2025-05-12', 'excerpt' => 'Setting up a new place to write.'],
                ]],
                'is_active' => true,
            ]);
        }
    }
}
