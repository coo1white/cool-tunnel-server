<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="{{ $site->tagline ?? 'Independent software consultancy specialising in calm infrastructure.' }}">
<meta name="robots" content="index,follow">
<meta property="og:type" content="website">
<meta property="og:title" content="{{ $site->title ?? 'Calm Software Consulting' }}">
<meta property="og:description" content="{{ $site->tagline ?? 'Boring infrastructure, done well.' }}">
<title>{{ $site->title ?? 'Calm Software Consulting' }}</title>
<link rel="canonical" href="https://{{ request()->host() }}/">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%234338ca'/%3E%3Ctext x='50%25' y='55%25' fill='white' font-family='-apple-system,sans-serif' font-weight='700' font-size='10' text-anchor='middle' dominant-baseline='central'%3EC%3C/text%3E%3C/svg%3E">
<style>
:root { --ink: #1a1d21; --muted: #6b7280; --line: #e5e7eb; --brand: #4338ca; --bg: #fafafa; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; color: var(--ink); background: #fff; line-height: 1.55; }
nav { display: flex; justify-content: space-between; align-items: center; padding: 1rem 1.5rem; max-width: 72rem; margin: 0 auto; border-bottom: 1px solid var(--line); }
nav .brand { font-weight: 700; letter-spacing: -0.01em; }
nav ul { list-style: none; display: flex; gap: 1.5rem; }
nav a { color: var(--ink); text-decoration: none; font-size: 0.92rem; }
nav a:hover { color: var(--brand); }

.hero { padding: 5rem 1.5rem 3rem; text-align: center; background: linear-gradient(180deg, var(--bg) 0%, #fff 100%); }
.hero h1 { font-size: clamp(2rem, 5vw, 2.75rem); margin: 0 auto 0.75rem; max-width: 40rem; letter-spacing: -0.02em; line-height: 1.15; }
.hero p { color: var(--muted); max-width: 32rem; margin: 0 auto 1.5rem; }
.btn { display: inline-block; padding: 0.7rem 1.5rem; border-radius: 0.4rem; background: var(--brand); color: white; text-decoration: none; font-weight: 600; }
.btn-ghost { background: transparent; color: var(--brand); border: 1px solid var(--brand); margin-left: 0.5rem; }

section { padding: 4rem 1.5rem; max-width: 72rem; margin: 0 auto; }
section h2 { font-size: 1.5rem; margin-bottom: 2rem; letter-spacing: -0.01em; }

.services { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 1.25rem; }
.card { padding: 1.5rem; border: 1px solid var(--line); border-radius: 0.5rem; background: white; }
.card h3 { margin: 0 0 0.5rem; font-size: 1.05rem; }
.card p { color: var(--muted); margin: 0; font-size: 0.92rem; }

.testimonial { background: var(--bg); padding: 4rem 1.5rem; }
.testimonial blockquote { max-width: 48rem; margin: 0 auto; font-size: 1.15rem; line-height: 1.55; color: var(--ink); font-style: italic; }
.testimonial cite { display: block; margin-top: 1rem; font-style: normal; color: var(--muted); font-size: 0.9rem; }

.process { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1.5rem; }
.process div { padding: 1rem; }
.process .step { color: var(--brand); font-weight: 700; font-size: 0.85rem; letter-spacing: 0.05em; }
.process h3 { font-size: 1rem; margin: 0.25rem 0 0.5rem; }
.process p { color: var(--muted); font-size: 0.9rem; margin: 0; }

footer { padding: 3rem 1.5rem 2rem; text-align: center; color: var(--muted); border-top: 1px solid var(--line); font-size: 0.85rem; }
footer a { color: var(--muted); text-decoration: none; margin: 0 0.5rem; }
footer a:hover { color: var(--brand); }
</style>
</head>
<body>

<nav>
    <span class="brand">{{ $site->title ?? 'Calm Software' }}</span>
    <ul>
        <li><a href="/services">Services</a></li>
        <li><a href="/work">Selected work</a></li>
        <li><a href="/about">About</a></li>
        <li><a href="/contact">Contact</a></li>
    </ul>
</nav>

<header class="hero">
    <h1>{{ $site->title ?? 'Calm Software Consulting' }}</h1>
    <p>{{ $site->tagline ?? 'Boring infrastructure, done well — for teams that need things to keep working.' }}</p>
    <a href="/contact" class="btn">Get in touch</a>
    <a href="/services" class="btn btn-ghost">Our services</a>
</header>

<section>
    <h2>What we do</h2>
    <div class="services">
@foreach (($site->payload['services'] ?? [
    ['name' => 'Architecture review',    'desc' => 'Independent look at your system design — what is load-bearing, what isn\'t, what fails first.'],
    ['name' => 'Performance audit',      'desc' => 'Find what is slow and quantify the fix. Numbers, not vibes.'],
    ['name' => 'On-call rotation help',  'desc' => 'Fewer pages, better runbooks. We sit a rotation with you for two weeks.'],
    ['name' => 'Migration planning',     'desc' => 'Phased moves between clouds, databases, or frameworks — without big-bang weekends.'],
    ['name' => 'Cost reduction',         'desc' => 'Find the 80% of bill that comes from 20% of footprint. Trim without breaking.'],
    ['name' => 'Hiring support',         'desc' => 'Loop design, take-home rubric, panel calibration. We sit in for the first three loops.'],
]) as $svc)
        <article class="card">
            <h3>{{ $svc['name'] ?? '' }}</h3>
            <p>{{ $svc['desc'] ?? '' }}</p>
        </article>
@endforeach
    </div>
</section>

<section class="testimonial">
    <blockquote>
        "They told us what to delete, not what to add. Two weeks of pairing
        and our P95 dropped 40%. The infra report we got afterwards is
        still circulating internally a year later."
        <cite>— VP of Engineering, mid-stage SaaS company</cite>
    </blockquote>
</section>

<section>
    <h2>How we work</h2>
    <div class="process">
        <div>
            <span class="step">01 — INTRO</span>
            <h3>30-minute call</h3>
            <p>Tell us where it hurts. We tell you whether we can help and how long it might take.</p>
        </div>
        <div>
            <span class="step">02 — SCOPE</span>
            <h3>Written brief</h3>
            <p>One-page scope, fixed price or capped hours. No retainer, no surprise add-ons.</p>
        </div>
        <div>
            <span class="step">03 — WORK</span>
            <h3>Pair with your team</h3>
            <p>We sit in your tooling, on your channels, in your standups. No theatrical handovers.</p>
        </div>
        <div>
            <span class="step">04 — HAND OFF</span>
            <h3>Documented</h3>
            <p>Every decision and trade-off is in the wiki on the day we leave. You own it after.</p>
        </div>
    </div>
</section>

<footer>
    <p>&copy; {{ date('Y') }} {{ $site->title ?? 'Calm Software Consulting' }}. All rights reserved.</p>
    <p style="margin-top:0.5rem">
        <a href="/privacy">Privacy</a> ·
        <a href="/terms">Terms</a> ·
        <a href="/contact">Contact</a>
    </p>
</footer>

</body>
</html>
