<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{ $site->title ?? 'Consultancy' }}</title>
<link rel="stylesheet" href="/static/style.css">
<style>
body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #222; background: #fff; }
.hero { padding: 6rem 1.5rem 4rem; text-align: center; background: linear-gradient(180deg,#f7f7f8 0%,#fff 100%); }
.hero h1 { font-size: 2.5rem; margin: 0 0 0.5rem; }
.hero p { color: #555; max-width: 32rem; margin: 0 auto 1.5rem; line-height: 1.5; }
.btn { display: inline-block; padding: 0.6rem 1.25rem; border-radius: 0.4rem; background: #4f46e5; color: white; text-decoration: none; font-weight: 600; }
.services { max-width: 64rem; margin: 4rem auto; padding: 0 1.5rem; display: grid; grid-template-columns: repeat(auto-fit,minmax(260px,1fr)); gap: 1.5rem; }
.card { padding: 1.5rem; border: 1px solid #eee; border-radius: 0.5rem; }
.card h3 { margin: 0 0 0.5rem; }
.card p { color: #555; line-height: 1.5; margin: 0; }
footer { padding: 3rem 1.5rem; text-align: center; color: #888; }
</style>
</head>
<body>
<section class="hero">
    <h1>{{ $site->title ?? 'Calm Software Consulting' }}</h1>
    <p>{{ $site->tagline ?? 'Boring infrastructure, done well.' }}</p>
    <a href="mailto:hello@example.com" class="btn">Get in touch</a>
</section>

<section class="services">
@foreach (($site->payload['services'] ?? []) as $svc)
    <div class="card">
        <h3>{{ $svc['name'] ?? '' }}</h3>
        <p>{{ $svc['desc'] ?? '' }}</p>
    </div>
@endforeach
</section>

<footer>&copy; {{ date('Y') }} — all rights reserved.</footer>
</body>
</html>
