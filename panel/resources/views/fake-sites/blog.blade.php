<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="{{ $site->tagline ?? 'Occasional writing about software and design.' }}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:title" content="{{ $site->title ?? 'Notes' }}">
<meta property="og:description" content="{{ $site->tagline ?? 'Occasional writing.' }}">
<title>{{ $site->title ?? 'Notes' }}</title>
<link rel="canonical" href="https://{{ request()->host() }}/">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23222'/%3E%3Ctext x='50%25' y='55%25' fill='%23fcfcfc' font-family='Georgia,serif' font-size='10' text-anchor='middle' dominant-baseline='central'%3EN%3C/text%3E%3C/svg%3E">
<style>
* { box-sizing: border-box; }
body { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem; line-height: 1.6; color: #222; background: #fcfcfc; font-family: Georgia, "Times New Roman", serif; }
header h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
header p { color: #666; margin-bottom: 2.5rem; }
article { margin: 2rem 0; padding-bottom: 1.5rem; border-bottom: 1px solid #eee; }
article:last-child { border-bottom: none; }
article time { display: block; color: #888; font-size: 0.85rem; margin-bottom: 0.25rem; }
article h2 { font-size: 1.2rem; margin: 0 0 0.5rem; }
article h2 a { color: #222; text-decoration: none; }
article h2 a:hover { text-decoration: underline; }
article p { color: #444; }
footer { margin-top: 4rem; color: #888; font-size: 0.85rem; text-align: center; }
@media (prefers-color-scheme: dark) {
    body { color: #ddd; background: #14171a; }
    article { border-bottom-color: #2a2f35; }
    article h2 a { color: #ddd; }
    article p { color: #b0b6bd; }
    header p, footer, article time { color: #888; }
}
</style>
</head>
<body>
<header>
    <h1>{{ $site->title ?? 'Notes' }}</h1>
    <p>{{ $site->tagline ?? 'Occasional writing.' }}</p>
</header>

@foreach (($site->payload['posts'] ?? []) as $post)
<article>
    <time datetime="{{ $post['date'] ?? '' }}">{{ $post['date'] ?? '' }}</time>
    <h2><a href="/{{ \Illuminate\Support\Str::slug($post['title'] ?? 'untitled') }}">{{ $post['title'] ?? 'Untitled' }}</a></h2>
    <p>{{ $post['excerpt'] ?? '' }}</p>
</article>
@endforeach

<footer>&copy; {{ date('Y') }} {{ $site->title ?? '' }}.</footer>
</body>
</html>
