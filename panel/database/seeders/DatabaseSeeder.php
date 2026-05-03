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

        // Seed three cover-site templates so the operator has
        // something to pick from on first login.
        if (FakeWebsite::count() === 0) {
            FakeWebsite::create([
                'slug'     => 'minimal-blog',
                'name'     => 'Minimal Blog',
                'template' => 'blog',
                'title'    => 'Notes & Drafts',
                'tagline'  => 'Occasional writing about software and design.',
                'payload'  => ['posts' => [
                    ['title' => 'Hello, world',  'date' => '2026-04-12', 'excerpt' => 'A first post.'],
                    ['title' => 'Half-baked ideas', 'date' => '2026-04-21', 'excerpt' => 'A list of things I want to try.'],
                    ['title' => 'On simplicity', 'date' => '2026-05-01', 'excerpt' => 'Why doing less often beats doing more.'],
                ]],
                'is_active' => true,
            ]);

            FakeWebsite::create([
                'slug'     => 'consultancy',
                'name'     => 'Solo Consultancy',
                'template' => 'corporate',
                'title'    => 'Calm Software Consulting',
                'tagline'  => 'Boring infrastructure, done well.',
                'payload'  => ['services' => [
                    ['name' => 'Architecture review',   'desc' => 'Independent look at your system design.'],
                    ['name' => 'Performance audit',     'desc' => 'Find what is slow and quantify the fix.'],
                    ['name' => 'On-call rotation help', 'desc' => 'Fewer pages, better runbooks.'],
                ]],
                'is_active' => false,
            ]);

            FakeWebsite::create([
                'slug'     => 'portfolio',
                'name'     => 'Personal Portfolio',
                'template' => 'portfolio',
                'title'    => 'Things I have built',
                'tagline'  => 'Photographs, side-projects, and the occasional essay.',
                'payload'  => ['projects' => [
                    ['name' => 'Tide chart for the bay', 'year' => 2024],
                    ['name' => 'Static site generator',   'year' => 2025],
                    ['name' => 'Small synth in Rust',     'year' => 2026],
                ]],
                'is_active' => false,
            ]);
        }
    }
}
