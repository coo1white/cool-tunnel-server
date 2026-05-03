<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="{{ $site->tagline ?? 'A scratch list of things I have built.' }}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:title" content="{{ $site->title ?? 'Portfolio' }}">
<meta property="og:description" content="{{ $site->tagline ?? 'A scratch list.' }}">
<title>{{ $site->title ?? 'Portfolio' }}</title>
<link rel="canonical" href="https://{{ request()->host() }}/">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23fafafa'/%3E%3Ctext x='50%25' y='55%25' fill='%23222' font-family='Inter,sans-serif' font-weight='700' font-size='10' text-anchor='middle' dominant-baseline='central'%3EP%3C/text%3E%3C/svg%3E">
<style>
* { box-sizing: border-box; }
body { font-family: "Inter", -apple-system, sans-serif; color: #222; background: #fafafa; margin: 0; }
.wrap { max-width: 56rem; margin: 0 auto; padding: 4rem 1.5rem; }
header h1 { font-size: 2rem; margin: 0 0 0.5rem; }
header p  { color: #666; margin-bottom: 3rem; line-height: 1.5; }
.grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 1rem; }
.tile { padding: 1.25rem; background: white; border: 1px solid #eee; border-radius: 0.5rem; }
.tile h3 { margin: 0 0 0.25rem; font-size: 1rem; }
.tile time { color: #888; font-size: 0.85rem; }
footer { margin-top: 4rem; color: #888; font-size: 0.85rem; }
@media (prefers-color-scheme: dark) {
    body { color: #ddd; background: #14171a; }
    .tile { background: #1d2126; border-color: #2a2f35; }
    header p, footer, .tile time { color: #888; }
}
@media (max-width: 480px) {
    .wrap { padding: 2rem 1rem; }
}
</style>
</head>
<body>
<div class="wrap">
    <header>
        <h1>{{ $site->title ?? 'Things I have built' }}</h1>
        <p>{{ $site->tagline ?? 'A scratch list.' }}</p>
    </header>

    <div class="grid">
@foreach (($site->payload['projects'] ?? []) as $p)
        <article class="tile">
            <h3>{{ $p['name'] ?? '' }}</h3>
            <time datetime="{{ $p['year'] ?? '' }}">{{ $p['year'] ?? '' }}</time>
        </article>
@endforeach
    </div>

    <footer>&copy; {{ date('Y') }} {{ $site->title ?? '' }}.</footer>
</div>
</body>
</html>
