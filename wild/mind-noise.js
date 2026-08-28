/* MindNoise — shared "thought noise" engine for the portfolio.
   Registers window.MindNoise. Handles: canvas noise field (3 modes), mood colour
   cycling, attention drop-outs (freeze), restless typography, proximity focus,
   glitch scheduling, hyperfocus groups, and optional audio. */
(function () {
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rand = (a, b) => a + Math.random() * (b - a);

  const MOODS = [
    [0.00, 'DRIFTING · 走神'],
    [0.22, 'SHIFTING · 切换'],
    [0.44, 'IGNITING · 来劲'],
    [0.66, 'SURGING · 冲刺'],
    [0.86, 'RESETTING · 歇会'],
  ];
  const moodLabel = (p) => {
    let l = MOODS[0][1];
    for (const [t, name] of MOODS) if (p >= t) l = name;
    return l;
  };

  function makeAudio() {
    let ctx = null, drone = null, master = null, on = false;
    function build() {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
      drone = ctx.createGain(); drone.gain.value = 0.5; drone.connect(master);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 320; lp.connect(drone);
      [55, 82.4, 110.3].forEach((f, i) => {
        const o = ctx.createOscillator(); o.type = i === 2 ? 'triangle' : 'sine'; o.frequency.value = f;
        const g = ctx.createGain(); g.gain.value = i === 2 ? 0.035 : 0.09;
        const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05 + i * 0.031;
        const lg = ctx.createGain(); lg.gain.value = g.gain.value * 0.6;
        lfo.connect(lg); lg.connect(g.gain); lfo.start();
        o.connect(g); g.connect(lp); o.start();
      });
      const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last * 0.97) + (Math.random() * 2 - 1) * 0.03; d[i] = last; }
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 640; bp.Q.value = 0.7;
      const ng = ctx.createGain(); ng.gain.value = 0.55;
      src.connect(bp); bp.connect(ng); ng.connect(drone); src.start();
    }
    return {
      get on() { return on; },
      toggle() {
        if (!ctx) build();
        ctx.resume();
        on = !on;
        master.gain.cancelScheduledValues(ctx.currentTime);
        master.gain.linearRampToValueAtTime(on ? 0.28 : 0, ctx.currentTime + (on ? 1.6 : 0.5));
        return on;
      },
      blip(freq, dur, vol) {
        if (!on || !ctx) return;
        const t = ctx.currentTime;
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = freq;
        const g = ctx.createGain(); g.gain.value = 0;
        g.gain.linearRampToValueAtTime(vol, t + 0.008);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
      },
      duck(ms) {
        if (!on || !ctx) return;
        const t = ctx.currentTime;
        master.gain.cancelScheduledValues(t);
        master.gain.setValueAtTime(master.gain.value, t);
        master.gain.linearRampToValueAtTime(0.03, t + 0.05);
        master.gain.linearRampToValueAtTime(0.28, t + ms / 1000 + 0.4);
      },
    };
  }

  function init(opts) {
    opts = opts || {};
    const mode = opts.mode || 'traffic';
    const cv = document.querySelector('[data-noise]');
    const veil = document.querySelector('[data-veil]');
    const readouts = [...document.querySelectorAll('[data-mood-readout]')];
    const audio = makeAudio();
    const root = document.documentElement;
    let W = 0, H = 0, dpr = 1;
    const ctx = cv ? cv.getContext('2d') : null;
    const pointer = { x: innerWidth / 2, y: innerHeight / 2, active: false };
    const S = { sp: 1, frozen: false, nextFreeze: performance.now() + rand(6000, 12000), phase: 0, hue: 250, boost: 1, zone: 1 };
    const period = (opts.moodPeriod || 46) * 1000;
    const chaos = opts.chaos == null ? 1 : opts.chaos;

    function resize() {
      if (!cv) return;
      dpr = Math.min(2, devicePixelRatio || 1);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = W * dpr; cv.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      build();
    }

    /* ---- particle systems ---- */
    let lanes = [], streaks = [], dots = [], swarm = [];
    function build() {
      if (mode === 'traffic') {
        const n = Math.max(14, Math.round(H / 34));
        lanes = Array.from({ length: n }, (_, i) => ({
          y: ((i + 0.5) / n) * H + rand(-5, 5),
          v: rand(0.35, 3.4) * (Math.random() < 0.18 ? -1 : 1),
        }));
        streaks = Array.from({ length: Math.round(n * 3.4) }, () => {
          const l = lanes[(Math.random() * lanes.length) | 0];
          return { l, x: rand(-200, W + 200), len: rand(28, 300), a: rand(0.12, 0.85), w: rand(0.7, 2.1) };
        });
      } else if (mode === 'instrument') {
        const cols = Math.round(W / 26), rows = Math.round(H / 26);
        dots = [];
        for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++)
          dots.push({ x: (i + 0.5) * (W / cols), y: (j + 0.5) * (H / rows), p: Math.random() * 6.28, s: rand(0.3, 1.9) });
      } else {
        swarm = Array.from({ length: Math.round(clamp(W * H / 12000, 70, 190)) }, () => ({
          x: Math.random() * W, y: Math.random() * H,
          vx: rand(-0.5, 0.5), vy: rand(-0.4, 0.4), z: rand(0.25, 1),
        }));
      }
    }

    let prev = performance.now();
    function frame(now) {
      const dt = clamp(now - prev, 0, 60); prev = now;

      /* mood cycle */
      S.phase = ((now / period) % 1);
      const e = 0.5 - 0.5 * Math.cos(S.phase * Math.PI * 2);
      S.hue = (250 + 135 * e) % 360;
      const chroma = 0.085 + 0.085 * e;
      root.style.setProperty('--em-h', S.hue.toFixed(1));
      root.style.setProperty('--em-c', chroma.toFixed(3));
      const label = moodLabel(S.phase);
      readouts.forEach((r) => { if (r.textContent !== label) r.textContent = label; });

      /* attention drop-out */
      if (!S.frozen && now > S.nextFreeze && opts.dropouts !== false) {
        S.frozen = true;
        const dur = rand(520, 1050);
        if (veil) veil.style.opacity = '0.62';
        audio.duck(dur);
        setTimeout(() => {
          S.frozen = false;
          if (veil) veil.style.opacity = '0';
          S.nextFreeze = performance.now() + rand(7000, 16000);
        }, dur);
      }
      const target = S.frozen ? 0 : (0.45 + 1.55 * e) * S.boost * S.zone * chaos;
      S.sp += (target - S.sp) * (S.frozen ? 0.5 : 0.045);

      if (ctx) draw(dt);
      restless(now);
      requestAnimationFrame(frame);
    }

    function draw(dt) {
      const h = S.hue, k = S.sp * (dt / 16.7);
      ctx.fillStyle = 'rgba(11,11,15,0.26)';
      ctx.fillRect(0, 0, W, H);
      const glow = 0.35 + 0.65 * (0.5 - 0.5 * Math.cos(S.phase * 6.28));

      if (mode === 'traffic') {
        ctx.lineWidth = 1;
        ctx.strokeStyle = `hsla(${h},30%,55%,0.05)`;
        lanes.forEach((l) => { ctx.beginPath(); ctx.moveTo(0, l.y); ctx.lineTo(W, l.y); ctx.stroke(); });
        streaks.forEach((s) => {
          s.x += s.l.v * k * 3.1;
          if (s.l.v > 0 && s.x - s.len > W) s.x = -s.len - rand(0, 300);
          if (s.l.v < 0 && s.x + s.len < 0) s.x = W + s.len + rand(0, 300);
          const g = ctx.createLinearGradient(s.x - s.len, 0, s.x, 0);
          const a = s.a * (0.35 + 0.65 * glow);
          g.addColorStop(0, `hsla(${h},70%,62%,0)`);
          g.addColorStop(1, `hsla(${h},${55 + 30 * glow}%,${58 + 14 * glow}%,${a})`);
          ctx.strokeStyle = g; ctx.lineWidth = s.w;
          ctx.beginPath(); ctx.moveTo(s.x - s.len, s.l.y); ctx.lineTo(s.x, s.l.y); ctx.stroke();
        });
      } else if (mode === 'instrument') {
        const t = performance.now() / 1000;
        dots.forEach((d) => {
          const a = 0.05 + 0.32 * Math.pow(0.5 + 0.5 * Math.sin(t * d.s * S.sp + d.p), 3);
          ctx.fillStyle = `hsla(${h},60%,${52 + 18 * glow}%,${a})`;
          ctx.fillRect(d.x, d.y, 1.6, 1.6);
        });
        for (let i = 0; i < 3; i++) {
          ctx.beginPath();
          const amp = (18 + i * 26) * (0.4 + glow), f = 0.004 + i * 0.0026, ph = t * (0.25 + i * 0.5) * S.sp;
          for (let x = 0; x <= W; x += 6) {
            const y = H * (0.28 + i * 0.23) + Math.sin(x * f + ph) * amp + Math.sin(x * f * 3.7 - ph * 1.7) * amp * 0.22;
            x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
          }
          ctx.strokeStyle = `hsla(${h},${50 + 25 * glow}%,60%,${0.07 + 0.12 * glow})`;
          ctx.lineWidth = 1.1; ctx.stroke();
        }
      } else {
        swarm.forEach((p) => {
          if (pointer.active) {
            const dx = pointer.x - p.x, dy = pointer.y - p.y, d2 = dx * dx + dy * dy;
            if (d2 < 62500) { const f = 0.00022 * p.z; p.vx += dx * f; p.vy += dy * f; }
          }
          p.x += p.vx * k * 1.8; p.y += p.vy * k * 1.8;
          p.vx *= 0.995; p.vy *= 0.995;
          if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20;
          if (p.y < -20) p.y = H + 20; if (p.y > H + 20) p.y = -20;
        });
        for (let i = 0; i < swarm.length; i++) {
          const a = swarm[i];
          for (let j = i + 1; j < swarm.length; j++) {
            const b = swarm[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
            if (d2 < 8100) {
              ctx.strokeStyle = `hsla(${h},60%,62%,${(1 - d2 / 8100) * 0.12 * (0.4 + glow)})`;
              ctx.lineWidth = 0.6;
              ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            }
          }
          ctx.fillStyle = `hsla(${h},${55 + 30 * glow}%,${56 + 16 * glow}%,${0.2 + 0.55 * a.z * (0.4 + glow)})`;
          ctx.beginPath(); ctx.arc(a.x, a.y, 0.8 + a.z * 1.5, 0, 6.283); ctx.fill();
        }
      }
    }

    /* ---- restless typography ---- */
    const restlessItems = [...document.querySelectorAll('[data-restless-item]')].map((el) => ({
      el, ox: rand(-16, 16) * chaos, oy: rand(-7, 7) * chaos, or: rand(-1.5, 1.5) * chaos,
      ax: rand(1.5, 5) * chaos, ay: rand(1, 3.5) * chaos, ar: rand(0.15, 0.6) * chaos, t: rand(0, 6.28), sp: rand(0.06, 0.17),
    }));
    const drifters = [...document.querySelectorAll('[data-drift]')].map((el) => ({
      el, ax: rand(6, 26), ay: rand(4, 18), t: rand(0, 6.28), sp: rand(0.03, 0.11),
      depth: parseFloat(el.dataset.drift) || 1,
    }));
    function restless(now) {
      const s = now / 1000;
      restlessItems.forEach((it) => {
        const p = it.t + s * it.sp * (0.5 + S.sp * 0.5);
        it.el.style.transform =
          `translate(${(it.ox + Math.sin(p) * it.ax).toFixed(2)}px,${(it.oy + Math.cos(p * 1.3) * it.ay).toFixed(2)}px) rotate(${(it.or + Math.sin(p * 0.7) * it.ar).toFixed(3)}deg)`;
      });
      drifters.forEach((it) => {
        const p = it.t + s * it.sp * (0.4 + S.sp * 0.6);
        const px = (pointer.x / innerWidth - 0.5), py = (pointer.y / innerHeight - 0.5);
        it.el.style.transform =
          `translate(${(Math.sin(p) * it.ax - px * 26 * it.depth).toFixed(2)}px,${(Math.cos(p * 1.21) * it.ay - py * 18 * it.depth).toFixed(2)}px)`;
      });
    }

    /* ---- proximity focus ---- */
    const proxEls = [...document.querySelectorAll('[data-prox]')];
    let proxRects = [];
    function measure() { proxRects = proxEls.map((el) => ({ el, r: el.getBoundingClientRect(), max: parseFloat(el.dataset.prox) || 260 })); }
    function focusPass() {
      proxRects.forEach(({ el, r, max }) => {
        const dx = Math.max(r.left - pointer.x, 0, pointer.x - r.right);
        const dy = Math.max(r.top - pointer.y, 0, pointer.y - r.bottom);
        const t = pointer.active ? clamp(1 - Math.hypot(dx, dy) / max, 0, 1) : 0;
        const ease = t * t * (3 - 2 * t);
        el.style.filter = `blur(${((1 - ease) * 5.5).toFixed(2)}px)`;
        el.style.opacity = (0.3 + 0.7 * ease).toFixed(3);
      });
    }

    /* ---- hyperfocus groups ---- */
    document.querySelectorAll('[data-focus-group]').forEach((group) => {
      const items = [...group.querySelectorAll('[data-focus-item]')];
      const apply = (active) => {
        group.dataset.focused = active ? '1' : '0';
        items.forEach((it) => {
          const on = it === active;
          const detail = it.querySelector('[data-focus-detail]');
          it.style.filter = active && !on ? 'blur(7px) brightness(0.42) saturate(0.5)' : 'none';
          it.style.opacity = active && !on ? '0.34' : '1';
          it.style.transform = on ? 'scale(1.022)' : 'scale(1)';
          it.style.zIndex = on ? '5' : '1';
          if (detail) {
            detail.style.maxHeight = on ? detail.scrollHeight + 40 + 'px' : '0px';
            detail.style.opacity = on ? '1' : '0';
          }
        });
      };
      items.forEach((it) => {
        it.addEventListener('pointerenter', () => { apply(it); audio.blip(rand(520, 900), 0.09, 0.05); S.boost = 1.9; });
        it.addEventListener('click', () => audio.blip(196, 0.22, 0.09));
      });
      group.addEventListener('pointerleave', () => { apply(null); S.boost = 1; });
    });

    /* ---- glitch scheduling ---- */
    if (opts.glitch !== false) document.querySelectorAll('[data-glitch]').forEach((el) => {
      el.style.animation = `glitch ${rand(4.5, 11).toFixed(2)}s linear ${rand(0, 6).toFixed(2)}s infinite`;
      el.style.willChange = 'transform, opacity';
    });

    /* ---- sound toggle ---- */
    document.querySelectorAll('[data-sound-toggle]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const on = audio.toggle();
        btn.textContent = on ? 'SOUND · ON' : 'SOUND · OFF';
        btn.style.color = on ? 'oklch(0.86 0.15 var(--em-h))' : '';
        if (on) audio.blip(660, 0.12, 0.06);
      });
    });
    document.querySelectorAll('[data-sfx]').forEach((el) => {
      el.addEventListener('pointerenter', () => audio.blip(rand(700, 1200), 0.06, 0.04));
    });

    addEventListener('pointermove', (e) => {
      pointer.x = e.clientX; pointer.y = e.clientY; pointer.active = true;
      focusPass();
    }, { passive: true });
    addEventListener('pointerleave', () => { pointer.active = false; focusPass(); });
    addEventListener('resize', () => { resize(); measure(); });
    /* ---- scroll: zone intensity + parallax layers ---- */
    const zones = [...document.querySelectorAll('[data-intensity]')];
    const layers = [...document.querySelectorAll('[data-parallax]')].map((el) => ({
      el, f: parseFloat(el.dataset.parallax) || 0.2, host: el.closest('[data-parallax-host]') || el.parentElement,
    }));
    function onScroll() {
      measure();
      const mid = innerHeight * 0.45;
      let z = 1;
      zones.forEach((s) => {
        const r = s.getBoundingClientRect();
        if (r.top < mid && r.bottom > mid) z = parseFloat(s.dataset.intensity) || 1;
      });
      S.zone += (z - S.zone) * 0.35;
      layers.forEach((l) => {
        const r = l.host.getBoundingClientRect();
        l.el.style.transform = `translate3d(0,${(-(r.top - innerHeight * 0.5) * l.f).toFixed(1)}px,0)`;
      });
    }
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    resize(); measure(); focusPass();
    requestAnimationFrame(frame);
    return { audio, state: S };
  }

  window.MindNoise = { init };
})();
