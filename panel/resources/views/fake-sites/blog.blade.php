<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ $site->title ?? 'Notes' }}</title>
<link rel="stylesheet" href="/static/style.css">
<style>
body { max-width: 720px; margin: 0 auto; padding: 3rem 1.5rem; line-height: 1.6; color: #222; background: #fcfcfc; font-family: Georgia, "Times New Roman", serif; }
header h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
header p { color: #666; margin-bottom: 2.5rem; }
article { margin: 2rem 0; padding-bottom: 1.5rem; border-bottom: 1px solid #eee; }
article:last-child { border-bottom: none; }
article time { display: block; color: #888; font-size: 0.85rem; margin-bottom: 0.25rem; }
article h2 { font-size: 1.2rem; margin: 0 0 0.5rem; }
article h2 a { color: #222; text-decoration: none; }
article p { color: #444; }
footer { margin-top: 4rem; color: #888; font-size: 0.85rem; text-align: center; }
</style>
</head>
<body>
<header>
    <h1>{{ $site->title ?? 'Notes' }}</h1>
    <p>{{ $site->tagline ?? 'Occasional writing.' }}</p>
</header>

@foreach (($site->payload['posts'] ?? []) as $post)
<article>
    <time>{{ $post['date'] ?? '' }}</time>
    <h2><a href="/">{{ $post['title'] ?? 'Untitled' }}</a></h2>
    <p>{{ $post['excerpt'] ?? '' }}</p>
</article>
@endforeach

<footer>&copy; {{ date('Y') }} {{ $site->title ?? '' }}.</footer>
</body>
</html>
