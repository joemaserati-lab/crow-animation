(() => {
  const canvas = document.querySelector('#frameCanvas');
  const video = document.querySelector('#scrollVideoFallback');
  const root = document.documentElement;
  const body = document.body;
  const loaderText = document.querySelector('#loaderText');
  const mobileQuery = window.matchMedia('(pointer: coarse), (max-width: 767px)');
  const isNativeScroll = mobileQuery.matches;

  if (isNativeScroll) {
    root.classList.add('is-native-scroll');
    body.classList.add('is-native-scroll');
  }

  const config = {
    manifestPath: isNativeScroll ? 'frames-mobile-portrait/manifest.json' : 'frames/manifest.json',
    wheelSensitivity: 0.00018,
    touchSensitivity: 0.00042,
    keyboardImpulse: 0.018,
    introRatio: 0.075,
    outroRatio: 0.085,
    baseSmoothing: isNativeScroll ? 0.11 : 0.075,
    fastSmoothing: isNativeScroll ? 0.24 : 0.19,
    maxDevicePixelRatio: isNativeScroll ? 1.5 : 2,
    preloadConcurrency: isNativeScroll ? 6 : 8,
    initialPreloadRatio: isNativeScroll ? 0.34 : 0.28,
    lookAheadFrames: isNativeScroll ? 14 : 18,
    fallbackMinSeekDelta: 0.004,
    friction: isNativeScroll ? 0.86 : 0.90,
    velocityClamp: 0.07,
    settleThreshold: 0.00035,
    zoomAmount: isNativeScroll ? 0.105 : 0.18,
    zoomExtra: isNativeScroll ? 0.018 : 0.035,
    panXAmount: isNativeScroll ? -15 : -28,
    panYAmount: isNativeScroll ? -10 : -18,
    depthXAmount: isNativeScroll ? 12 : 24,
    depthYAmount: isNativeScroll ? 8 : 16,
    depthMax: isNativeScroll ? 0.44 : 0.72,
    grainMax: isNativeScroll ? 0.052 : 0.085,
  };

  let gl = null;
  let glProgram = null;
  let glTexture = null;
  let glUniforms = null;
  let ctx2d = null;
  let renderer = '2d';

  let manifest = null;
  let framePaths = [];
  let frames = [];
  let loadingFrames = new Set();
  let frameCount = 0;
  let loadedFrames = 0;
  let criticalFrames = 0;
  let canvasReady = false;
  let fallbackReady = false;
  let usingVideoFallback = false;

  let progress = 0;
  let targetProgress = 0;
  let inputVelocity = 0;
  let lastRenderedFrame = -1;
  let duration = 0;
  let currentTime = 0;
  let targetTime = 0;

  let rafId = null;
  let resizeRaf = null;
  let lastTouchY = 0;
  let lastTouchTs = 0;
  let stableViewportWidth = window.innerWidth;
  let stableViewportHeight = window.innerHeight;
  let stableMaxScroll = 0;

  const clamp = (value, min = 0, max = 1) => Math.min(Math.max(value, min), max);
  const mix = (a, b, t) => a + (b - a) * t;
  const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeOutExpo = (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
  const smoothstep = (a, b, t) => {
    const x = clamp((t - a) / (b - a));
    return x * x * (3 - 2 * x);
  };

  const scenes = [
    { in: 0.00, out: 0.10, from: 0.00, to: 0.04, ease: easeOutCubic },
    { in: 0.10, out: 0.36, from: 0.04, to: 0.34, ease: easeInOutCubic },
    { in: 0.36, out: 0.70, from: 0.34, to: 0.72, ease: easeInOutCubic },
    { in: 0.70, out: 0.91, from: 0.72, to: 0.94, ease: easeOutExpo },
    { in: 0.91, out: 1.00, from: 0.94, to: 1.00, ease: easeInOutCubic },
  ];

  function setLoader(text) {
    if (loaderText) loaderText.textContent = text;
  }

  function applyImpulse(delta) {
    inputVelocity = clamp(inputVelocity + delta, -config.velocityClamp, config.velocityClamp);
    startLoop();
  }

  function setProgress(value) {
    targetProgress = clamp(value);
    startLoop();
  }

  function applyStableMobileViewport() {
    if (!isNativeScroll) return;

    stableViewportWidth = window.innerWidth;
    stableViewportHeight = window.innerHeight;
    stableMaxScroll = stableViewportHeight * 5.2;

    root.style.setProperty('--mobile-vh', `${stableViewportHeight}px`);
    root.style.setProperty('--mobile-scroll-height', `${stableViewportHeight * 6.2}px`);
  }

  function getNativeScrollProgress() {
    if (stableMaxScroll <= 0) return targetProgress;
    return clamp(window.scrollY / stableMaxScroll);
  }

  function onNativeScroll() {
    setProgress(getNativeScrollProgress());
  }

  function mapToContentProgress(p) {
    const start = config.introRatio;
    const end = 1 - config.outroRatio;
    return clamp((p - start) / (end - start));
  }

  function mapTimeline(t) {
    const s = scenes.find((scene) => t >= scene.in && t <= scene.out) || scenes[scenes.length - 1];
    const local = clamp((t - s.in) / (s.out - s.in));
    return mix(s.from, s.to, s.ease(local));
  }

  function updateCssState(p) {
    const blackOpacity = clamp(1 - p / config.introRatio);
    const whiteOpacity = clamp((p - (1 - config.outroRatio)) / config.outroRatio);
    const contentP = mapToContentProgress(p);
    const eased = easeInOutCubic(contentP);
    const timelineP = mapTimeline(contentP);

    const zoom = 1 + easeOutExpo(contentP) * config.zoomAmount + smoothstep(0.68, 0.9, contentP) * config.zoomExtra;
    const panX = (eased - 0.5) * config.panXAmount;
    const panY = (timelineP - 0.5) * config.panYAmount;
    const depthOpacity = mix(0.18, config.depthMax, smoothstep(0.08, 0.82, contentP));
    const depthX = (eased - 0.5) * config.depthXAmount;
    const depthY = (timelineP - 0.5) * config.depthYAmount;
    const grainOpacity = mix(0.035, config.grainMax, smoothstep(0.18, 0.86, contentP));
    const uiOpacity = clamp(1 - p * 4.25);

    root.style.setProperty('--progress', p.toFixed(4));
    root.style.setProperty('--timeline-progress', timelineP.toFixed(4));
    root.style.setProperty('--black-opacity', blackOpacity.toFixed(3));
    root.style.setProperty('--white-opacity', whiteOpacity.toFixed(3));
    root.style.setProperty('--zoom', zoom.toFixed(4));
    root.style.setProperty('--pan-x', `${panX.toFixed(2)}px`);
    root.style.setProperty('--pan-y', `${panY.toFixed(2)}px`);
    root.style.setProperty('--depth-opacity', depthOpacity.toFixed(3));
    root.style.setProperty('--depth-x', `${depthX.toFixed(2)}px`);
    root.style.setProperty('--depth-y', `${depthY.toFixed(2)}px`);
    root.style.setProperty('--grain-opacity', grainOpacity.toFixed(3));
    root.style.setProperty('--ui-opacity', uiOpacity.toFixed(3));
  }

  function initWebGL() {
    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' }) ||
         canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'high-performance' });

    if (!gl) {
      ctx2d = canvas.getContext('2d', { alpha: false });
      renderer = '2d';
      return;
    }

    const vertexSource = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = (a_position + 1.0) * 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    const fragmentSource = `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D u_texture;
      uniform float u_progress;
      uniform vec2 u_resolution;
      uniform vec2 u_imageResolution;
      void main() {
        vec2 screenRatio = u_resolution / u_imageResolution;
        float scale = max(screenRatio.x, screenRatio.y);
        vec2 visible = u_resolution / (u_imageResolution * scale);
        vec2 uv = (v_uv - 0.5) * visible + 0.5;
        vec2 center = vec2(0.5, 0.5);
        vec2 offset = uv - center;
        float vignette = smoothstep(0.88, 0.22, length(offset));
        float aberration = 0.0015 + u_progress * 0.0025;
        float r = texture2D(u_texture, uv + offset * aberration).r;
        float g = texture2D(u_texture, uv).g;
        float b = texture2D(u_texture, uv - offset * aberration).b;
        vec3 color = vec3(r, g, b);
        color *= mix(0.86, 1.04, vignette);
        color += smoothstep(0.65, 1.0, u_progress) * 0.025;
        gl_FragColor = vec4(color, 1.0);
      }
    `;

    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(gl.getShaderInfoLog(shader));
      }
      return shader;
    };

    try {
      const vertex = compile(gl.VERTEX_SHADER, vertexSource);
      const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
      glProgram = gl.createProgram();
      gl.attachShader(glProgram, vertex);
      gl.attachShader(glProgram, fragment);
      gl.linkProgram(glProgram);
      if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(glProgram));
      }

      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

      const position = gl.getAttribLocation(glProgram, 'a_position');
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

      glTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, glTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      glUniforms = {
        progress: gl.getUniformLocation(glProgram, 'u_progress'),
        resolution: gl.getUniformLocation(glProgram, 'u_resolution'),
        imageResolution: gl.getUniformLocation(glProgram, 'u_imageResolution'),
      };

      renderer = 'webgl';
      body.classList.add('is-webgl');
    } catch (error) {
      console.warn('[Crow Animation] WebGL non disponibile, uso Canvas 2D:', error);
      gl = null;
      ctx2d = canvas.getContext('2d', { alpha: false });
      renderer = '2d';
    }
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, config.maxDevicePixelRatio);
    const width = Math.ceil(window.innerWidth * dpr);
    const viewportHeight = isNativeScroll ? stableViewportHeight : window.innerHeight;
    const height = Math.ceil(viewportHeight * dpr);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${viewportHeight}px`;
      if (gl) gl.viewport(0, 0, width, height);
      lastRenderedFrame = -1;
      drawFrameForProgress(progress, true);
    }
  }

  function drawImageCover2d(image) {
    if (!ctx2d || !image || !canvas.width || !canvas.height) return;

    const cw = canvas.width;
    const ch = canvas.height;
    const iw = image.naturalWidth || image.width;
    const ih = image.naturalHeight || image.height;
    const scale = Math.max(cw / iw, ch / ih);
    const sw = iw * scale;
    const sh = ih * scale;
    const sx = (cw - sw) * 0.5;
    const sy = (ch - sh) * 0.5;

    ctx2d.clearRect(0, 0, cw, ch);
    ctx2d.drawImage(image, sx, sy, sw, sh);
  }

  function drawImageWebGL(image, p) {
    if (!gl || !image) return;

    gl.useProgram(glProgram);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, glTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.uniform1f(glUniforms.progress, p);
    gl.uniform2f(glUniforms.resolution, canvas.width, canvas.height);
    gl.uniform2f(glUniforms.imageResolution, image.naturalWidth || image.width, image.naturalHeight || image.height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function getFrameIndexForProgress(p) {
    const contentP = mapTimeline(mapToContentProgress(p));
    return clamp(Math.round(contentP * (frameCount - 1)), 0, frameCount - 1);
  }

  function drawFrameForProgress(p, force = false) {
    if (!canvasReady || !frameCount) return;

    const index = getFrameIndexForProgress(p);
    if (!force && index === lastRenderedFrame) return;

    const frame = frames[index];
    if (!frame || !frame.complete) {
      requestFrameLoad(index);
      requestLookAhead(index);
      return;
    }

    if (renderer === 'webgl') drawImageWebGL(frame, mapToContentProgress(p));
    else drawImageCover2d(frame);

    lastRenderedFrame = index;
    requestLookAhead(index);
  }

  function updateVideoFallback(p, smoothing) {
    if (!fallbackReady || !duration) return;

    const contentP = mapTimeline(mapToContentProgress(p));
    const safeEnd = Math.max(duration - 0.04, 0);
    targetTime = contentP * safeEnd;
    currentTime += (targetTime - currentTime) * smoothing;

    if (Math.abs(video.currentTime - currentTime) > config.fallbackMinSeekDelta) {
      try { video.currentTime = currentTime; } catch (_) {}
    }
  }

  function loop() {
    if (Math.abs(inputVelocity) > 0.00001) {
      targetProgress = clamp(targetProgress + inputVelocity);
      if ((targetProgress === 0 && inputVelocity < 0) || (targetProgress === 1 && inputVelocity > 0)) {
        inputVelocity = 0;
      } else {
        inputVelocity *= config.friction;
      }
    }

    const distance = Math.abs(targetProgress - progress);
    const smoothing = distance > 0.08 ? config.fastSmoothing : config.baseSmoothing;
    progress += (targetProgress - progress) * smoothing;

    if (distance < config.settleThreshold) progress = targetProgress;

    updateCssState(progress);

    if (usingVideoFallback) updateVideoFallback(progress, smoothing);
    else drawFrameForProgress(progress);

    const stillMoving = Math.abs(targetProgress - progress) > config.settleThreshold ||
      Math.abs(inputVelocity) > 0.00001 ||
      Math.abs(targetTime - currentTime) > 0.002;

    rafId = stillMoving ? requestAnimationFrame(loop) : null;
  }

  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function normalizeWheelDelta(event) {
    const modeMultiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    return event.deltaY * modeMultiplier;
  }

  function onWheel(event) {
    event.preventDefault();
    applyImpulse(normalizeWheelDelta(event) * config.wheelSensitivity);
  }

  function onTouchStart(event) {
    if (!event.touches.length) return;
    lastTouchY = event.touches[0].clientY;
    lastTouchTs = performance.now();
    inputVelocity = 0;
  }

  function onTouchMove(event) {
    if (!event.touches.length) return;
    if (event.cancelable) event.preventDefault();

    const now = performance.now();
    const touchY = event.touches[0].clientY;
    const delta = lastTouchY - touchY;
    const dt = Math.max(now - lastTouchTs, 16);
    lastTouchY = touchY;
    lastTouchTs = now;

    setProgress(targetProgress + delta * config.touchSensitivity);
    inputVelocity = clamp((delta / dt) * config.touchSensitivity * 10, -config.velocityClamp, config.velocityClamp);
  }

  function onTouchEnd() {
    startLoop();
  }

  function onKeyDown(event) {
    const keys = ['ArrowDown', 'ArrowRight', 'PageDown', 'Space', 'ArrowUp', 'ArrowLeft', 'PageUp', 'Home', 'End'];
    if (!keys.includes(event.code)) return;

    event.preventDefault();

    if (event.code === 'Home') return setProgress(0);
    if (event.code === 'End') return setProgress(1);

    const direction = ['ArrowUp', 'ArrowLeft', 'PageUp'].includes(event.code) ? -1 : 1;
    const multiplier = event.code.includes('Page') ? 2.5 : 1;
    applyImpulse(direction * config.keyboardImpulse * multiplier);
  }

  async function loadManifest() {
    const response = await fetch(config.manifestPath, { cache: 'no-cache' });
    if (!response.ok) throw new Error('Manifest non trovato');
    return response.json();
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  async function requestFrameLoad(index) {
    if (index < 0 || index >= frameCount) return null;
    if (frames[index] || loadingFrames.has(index)) return frames[index] || null;

    loadingFrames.add(index);
    try {
      const image = await loadImage(framePaths[index]);
      frames[index] = image;
      loadedFrames += 1;
      const percent = Math.round((loadedFrames / frameCount) * 100);
      if (!body.classList.contains('is-ready')) setLoader(`Caricamento frame ${percent}%`);
      return image;
    } finally {
      loadingFrames.delete(index);
    }
  }

  function requestLookAhead(center) {
    const start = Math.max(0, center - Math.floor(config.lookAheadFrames / 3));
    const end = Math.min(frameCount - 1, center + config.lookAheadFrames);
    for (let i = start; i <= end; i += 1) requestFrameLoad(i);
  }

  async function preloadCriticalFrames() {
    criticalFrames = Math.max(12, Math.ceil(frameCount * config.initialPreloadRatio));
    const indices = new Set([0, frameCount - 1]);

    for (let i = 0; i < criticalFrames; i += 1) indices.add(i);

    const ordered = [...indices].sort((a, b) => a - b);
    let cursor = 0;

    const worker = async () => {
      while (cursor < ordered.length) {
        const index = ordered[cursor++];
        await requestFrameLoad(index);
        if (index === 0) drawFrameForProgress(0, true);
      }
    };

    await Promise.all(Array.from({ length: Math.min(config.preloadConcurrency, ordered.length) }, worker));
  }

  function preloadBackgroundFrames() {
    let index = 0;
    const batch = () => {
      let count = 0;
      while (index < frameCount && count < 6) {
        requestFrameLoad(index);
        index += 1;
        count += 1;
      }
      if (index < frameCount) {
        if ('requestIdleCallback' in window) requestIdleCallback(batch, { timeout: 600 });
        else setTimeout(batch, 80);
      }
    };
    batch();
  }

  async function initCanvasMode() {
    manifest = await loadManifest();

    if (!manifest.frames || !manifest.frames.length) {
      throw new Error('Manifest frame vuoto');
    }

    framePaths = manifest.frames;
    frameCount = framePaths.length;
    frames = new Array(frameCount);

    initWebGL();
    resizeCanvas();
    await preloadCriticalFrames();

    canvasReady = true;
    usingVideoFallback = false;
    body.classList.remove('is-video-fallback');
    body.classList.add('is-ready');
    drawFrameForProgress(0, true);
    preloadBackgroundFrames();
    startLoop();
  }

  function prepareFallback() {
    duration = video.duration || 0;
    fallbackReady = duration > 0;
    usingVideoFallback = true;
    body.classList.add('is-video-fallback', 'is-ready');
    video.pause();
    currentTime = video.currentTime || 0;
    updateCssState(progress);
    startLoop();
  }

  function initFallbackMode() {
    setLoader('Uso fallback video');
    video.addEventListener('loadedmetadata', prepareFallback, { once: true });
    video.addEventListener('canplay', prepareFallback, { once: true });
    video.addEventListener('play', () => video.pause());
    video.load();
  }

  function initEvents() {
    if (isNativeScroll) {
      const syncNativeViewport = () => {
        if (window.innerWidth === stableViewportWidth) {
          setProgress(getNativeScrollProgress());
          return;
        }

        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          applyStableMobileViewport();
          resizeCanvas();
          setProgress(getNativeScrollProgress());
        });
      };

      window.addEventListener('scroll', onNativeScroll, { passive: true });
      window.addEventListener('resize', syncNativeViewport);
      window.addEventListener('orientationchange', () => setTimeout(syncNativeViewport, 250));

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
          if (window.innerWidth !== stableViewportWidth) syncNativeViewport();
        });
      }

      return;
    }

    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('touchcancel', onTouchEnd, { passive: true });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', () => {
      cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(resizeCanvas);
      startLoop();
    });
  }

  async function init() {
    if (isNativeScroll) {
      applyStableMobileViewport();
      targetProgress = getNativeScrollProgress();
      progress = targetProgress;
    }

    updateCssState(progress);
    initEvents();

    try {
      await initCanvasMode();
    } catch (error) {
      console.warn('[Crow Animation] Canvas frame mode non disponibile:', error);
      initFallbackMode();
    }
  }

  init();
})();
