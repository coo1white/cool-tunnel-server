<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ $site->title ?? 'Portfolio' }}</title>
<link rel="stylesheet" href="/static/style.css">
<style>
body { font-family: "Inter", -apple-system, sans-serif; color: #222; background: #fafafa; }
.wrap { max-width: 56rem; margin: 0 auto; padding: 4rem 1.5rem; }
header h1 { font-size: 2rem; margin: 0 0 0.5rem; }
header p  { color: #666; margin-bottom: 3rem; line-height: 1.5; }
.grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(220px,1fr)); gap: 1rem; }
.tile { padding: 1.25rem; background: white; border: 1px solid #eee; border-radius: 0.5rem; }
.tile h3 { margin: 0 0 0.25rem; font-size: 1rem; }
.tile time { color: #888; font-size: 0.85rem; }
footer { margin-top: 4rem; color: #888; font-size: 0.85rem; }
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
            <time>{{ $p['year'] ?? '' }}</time>
        </article>
@endforeach
    </div>

    <footer>&copy; {{ date('Y') }}.</footer>
</div>
</body>
</html>
