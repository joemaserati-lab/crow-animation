(() => {
  'use strict';

  const canvas = document.querySelector('#frameCanvas');
  const video = document.querySelector('#scrollVideoFallback');
  const stage = document.querySelector('#scrubStage');
  const root = document.documentElement;
  const body = document.body;
  const loaderText = document.querySelector('#loaderText');
  const currentScript = document.currentScript;

  const ASSET_BASE = (window.CROW_ASSET_BASE ?? currentScript?.dataset.assetBase ?? '').trim();
  const DEBUG = new URLSearchParams(window.location.search).has('debug');
  const mobileQuery = window.matchMedia('(pointer: coarse), (max-width: 767px)');
  const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const isNativeScroll = mobileQuery.matches;
  const reducedMotion = reducedMotionQuery.matches;

  if (!canvas || !video || !stage) return;

  if (isNativeScroll) {
    root.classList.add('is-native-scroll');
    body.classList.add('is-native-scroll');
  }

  const capabilities = getCapabilities();
  const quality = pickQuality(capabilities);
  root.classList.add(`quality-${quality}`);

  const config = {
    manifestPath: isNativeScroll ? 'frames-mobile-portrait/manifest.json' : 'frames/manifest.json',
    wheelSensitivity: isNativeScroll ? 0.00018 : 0.000035,
    wheelDeltaCap: 180,
    touchSensitivity: 0.00040,
    keyboardImpulse: isNativeScroll ? 0.018 : 0.006,
    maxProgressStep: isNativeScroll ? 0.0036 : 0.0018,
    introRatio: 0.075,
    outroRatio: 0.085,
    baseSmoothing: isNativeScroll ? 0.065 : 0.045,
    fastSmoothing: isNativeScroll ? 0.095 : 0.070,
    maxDevicePixelRatio: quality === 'high' ? 1.5 : quality === 'medium' ? 1.35 : 1,
    preloadConcurrency: quality === 'high' ? 7 : quality === 'medium' ? 5 : 3,
    initialPreloadRatio: isNativeScroll ? 0.42 : quality === 'high' ? 0.34 : quality === 'medium' ? 0.27 : 0.20,
    lookAheadFrames: isNativeScroll ? 20 : quality === 'high' ? 18 : quality === 'medium' ? 12 : 7,
    backgroundBatchSize: isNativeScroll ? 5 : quality === 'high' ? 6 : quality === 'medium' ? 4 : 2,
    fallbackMinSeekDelta: reducedMotion ? 0.018 : 0.006,
    friction: isNativeScroll ? 0.84 : 0.82,
    velocityClamp: isNativeScroll ? 0.018 : 0.006,
    mobileScrollDistanceMultiplier: 6.0,
    mobileTargetSmoothing: 0.045,
    mobileMaxCatchupStep: 0.0034,
    settleThreshold: 0.00035,
    zoomAmount: quality === 'low' ? 0.07 : isNativeScroll ? 0.10 : 0.16,
    zoomExtra: quality === 'low' ? 0.0 : isNativeScroll ? 0.015 : 0.025,
    panXAmount: quality === 'low' ? -10 : isNativeScroll ? -15 : -24,
    panYAmount: quality === 'low' ? -7 : isNativeScroll ? -10 : -16,
    depthXAmount: isNativeScroll ? 10 : 20,
    depthYAmount: isNativeScroll ? 7 : 14,
    depthMax: quality === 'high' ? 0.58 : 0.34,
    grainMax: quality === 'high' ? 0.056 : quality === 'medium' ? 0.038 : 0,
    preferWebGL: quality === 'high' && !isNativeScroll && !reducedMotion,
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
  let loadingFrames = new Map();
  let frameCount = 0;
  let loadedFrames = 0;
  let criticalFrames = 0;
  let canvasReady = false;
  let fallbackReady = false;
  let usingVideoFallback = false;

  let progress = 0;
  let desiredProgress = 0;
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
  let currentViewportHeight = window.innerHeight;
  let stableMaxScroll = 0;
  let mobileNativeProgress = 0;
  let degraded = false;
  let longFrameCount = 0;
  let lastLoopTs = 0;
  let perfPanel = null;
  let lastPerfUpdate = 0;

  const cssCache = new Map();
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

  function getCapabilities() {
    const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection || {};
    return {
      isNativeScroll,
      reducedMotion,
      deviceMemory: navigator.deviceMemory || 4,
      hardwareConcurrency: navigator.hardwareConcurrency || 4,
      saveData: Boolean(connection.saveData),
      effectiveType: connection.effectiveType || 'unknown',
    };
  }

  function pickQuality(info) {
    if (info.reducedMotion || info.saveData || info.deviceMemory <= 2 || info.hardwareConcurrency <= 2) return 'low';
    if (info.isNativeScroll || info.deviceMemory <= 4 || /2g|3g/.test(info.effectiveType)) return 'medium';
    return 'high';
  }

  function setLoader(text) {
    if (loaderText) loaderText.textContent = text;
  }

  function setCssVar(name, value) {
    if (cssCache.get(name) === value) return;
    cssCache.set(name, value);
    root.style.setProperty(name, value);
  }

  function resolveAssetUrl(path) {
    if (!path) return path;
    if (/^(https?:)?\/\//i.test(path) || path.startsWith('data:') || path.startsWith('blob:')) return path;
    if (!ASSET_BASE) return path;
    return new URL(path.replace(/^\.\//, ''), ASSET_BASE.endsWith('/') ? ASSET_BASE : `${ASSET_BASE}/`).toString();
  }

  function applyImpulse(delta) {
    inputVelocity = clamp(inputVelocity + delta, -config.velocityClamp, config.velocityClamp);
    startLoop();
  }

  function setProgress(value) {
    desiredProgress = clamp(value);
    startLoop();
  }

  function getMobileViewportHeight(lockToStable = true) {
    const visualHeight = window.visualViewport ? window.visualViewport.height : 0;
    const stableHeight = lockToStable ? stableViewportHeight || 0 : 0;
    return Math.ceil(Math.max(window.innerHeight || 0, visualHeight || 0, stableHeight));
  }

  function applyStableMobileViewport(resetScrollDistance = true) {
    if (!isNativeScroll) return;
    const measuredHeight = getMobileViewportHeight(!resetScrollDistance);

    if (resetScrollDistance || stableMaxScroll <= 0) {
      stableViewportWidth = window.innerWidth;
      stableViewportHeight = measuredHeight;
      stableMaxScroll = stableViewportHeight * config.mobileScrollDistanceMultiplier;
    } else if (measuredHeight > stableViewportHeight) {
      stableViewportHeight = measuredHeight;
    }

    currentViewportHeight = stableViewportHeight;

    if (stableMaxScroll <= 0) {
      stableMaxScroll = stableViewportHeight * config.mobileScrollDistanceMultiplier;
    }

    setCssVar('--mobile-vh', `${stableViewportHeight}px`);
    setCssVar('--mobile-scroll-height', `${stableMaxScroll + stableViewportHeight}px`);
  }

  function getNativeScrollProgress() {
    if (stableMaxScroll <= 0) return desiredProgress;
    return clamp(window.scrollY / stableMaxScroll);
  }

  function onNativeScroll() {
    mobileNativeProgress = getNativeScrollProgress();
    startLoop();
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
    const depthOpacity = mix(0.14, config.depthMax, smoothstep(0.08, 0.82, contentP));
    const depthX = (eased - 0.5) * config.depthXAmount;
    const depthY = (timelineP - 0.5) * config.depthYAmount;
    const grainOpacity = mix(0.020, config.grainMax, smoothstep(0.18, 0.86, contentP));
    const uiOpacity = clamp(1 - p * 4.25);

    setCssVar('--progress', p.toFixed(4));
    setCssVar('--timeline-progress', timelineP.toFixed(4));
    setCssVar('--black-opacity', blackOpacity.toFixed(3));
    setCssVar('--white-opacity', whiteOpacity.toFixed(3));
    setCssVar('--zoom', zoom.toFixed(4));
    setCssVar('--pan-x', `${panX.toFixed(2)}px`);
    setCssVar('--pan-y', `${panY.toFixed(2)}px`);
    setCssVar('--depth-opacity', depthOpacity.toFixed(3));
    setCssVar('--depth-x', `${depthX.toFixed(2)}px`);
    setCssVar('--depth-y', `${depthY.toFixed(2)}px`);
    setCssVar('--grain-opacity', grainOpacity.toFixed(3));
    setCssVar('--ui-opacity', uiOpacity.toFixed(3));
  }

  function initWebGL() {
    if (!config.preferWebGL) {
      ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
      renderer = '2d';
      return;
    }

    gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'high-performance' }) ||
         canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'high-performance' });

    if (!gl) {
      ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
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
        float aberration = 0.0010 + u_progress * 0.0018;
        float r = texture2D(u_texture, uv + offset * aberration).r;
        float g = texture2D(u_texture, uv).g;
        float b = texture2D(u_texture, uv - offset * aberration).b;
        vec3 color = vec3(r, g, b);
        color *= mix(0.88, 1.03, vignette);
        color += smoothstep(0.65, 1.0, u_progress) * 0.018;
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
      ctx2d = canvas.getContext('2d', { alpha: false, desynchronized: true });
      renderer = '2d';
    }
  }

  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, config.maxDevicePixelRatio);
    const width = Math.ceil(window.innerWidth * dpr);
    const viewportHeight = isNativeScroll ? currentViewportHeight : window.innerHeight;
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
    ctx2d.imageSmoothingEnabled = true;
    ctx2d.imageSmoothingQuality = quality === 'low' ? 'medium' : 'high';
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

  function findNearestLoadedFrame(index) {
    if (frames[index]?.complete) return index;
    for (let distance = 1; distance <= config.lookAheadFrames; distance += 1) {
      const before = index - distance;
      const after = index + distance;
      if (before >= 0 && frames[before]?.complete) return before;
      if (after < frameCount && frames[after]?.complete) return after;
    }
    return -1;
  }

  function drawFrameForProgress(p, force = false) {
    if (!canvasReady || !frameCount) return;
    const index = getFrameIndexForProgress(p);
    if (!force && index === lastRenderedFrame) return;

    let frame = frames[index];
    let renderIndex = index;

    if (!frame?.complete) {
      requestFrameLoad(index, true);
      requestLookAhead(index);
      if (isNativeScroll) return;
      const nearest = findNearestLoadedFrame(index);
      if (nearest < 0) return;
      frame = frames[nearest];
      renderIndex = nearest;
    }

    if (renderer === 'webgl') drawImageWebGL(frame, mapToContentProgress(p));
    else drawImageCover2d(frame);

    lastRenderedFrame = renderIndex;
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

  function maybeDegrade(ts) {
    if (degraded || reducedMotion || quality === 'low') return;
    if (!lastLoopTs) {
      lastLoopTs = ts;
      return;
    }
    const delta = ts - lastLoopTs;
    lastLoopTs = ts;
    if (delta > 42) longFrameCount += 1;
    else longFrameCount = Math.max(0, longFrameCount - 1);

    if (longFrameCount >= 8) {
      degraded = true;
      config.maxDevicePixelRatio = Math.min(config.maxDevicePixelRatio, 1.15);
      config.lookAheadFrames = Math.min(config.lookAheadFrames, 8);
      config.grainMax = 0;
      root.classList.remove('quality-high', 'quality-medium');
      root.classList.add('quality-low');
      resizeCanvas();
    }
  }

  function loop(ts = performance.now()) {
    maybeDegrade(ts);

    if (isNativeScroll) {
      const nativeDelta = mobileNativeProgress - desiredProgress;
      if (Math.abs(nativeDelta) > 0.00001) {
        const catchup = clamp(
          nativeDelta * config.mobileTargetSmoothing,
          -config.mobileMaxCatchupStep,
          config.mobileMaxCatchupStep
        );
        desiredProgress = clamp(desiredProgress + catchup);
      }
    }

    if (Math.abs(inputVelocity) > 0.00001) {
      desiredProgress = clamp(desiredProgress + inputVelocity);
      if ((desiredProgress === 0 && inputVelocity < 0) || (desiredProgress === 1 && inputVelocity > 0)) {
        inputVelocity = 0;
      } else {
        inputVelocity *= config.friction;
      }
    }

    const targetDelta = desiredProgress - targetProgress;
    targetProgress += clamp(targetDelta, -config.maxProgressStep, config.maxProgressStep);

    const distance = Math.abs(targetProgress - progress);
    const smoothing = distance > 0.08 ? config.fastSmoothing : config.baseSmoothing;
    progress += (targetProgress - progress) * smoothing;

    if (distance < config.settleThreshold) progress = targetProgress;

    updateCssState(progress);

    if (usingVideoFallback) updateVideoFallback(progress, smoothing);
    else drawFrameForProgress(progress);

    if (DEBUG) updatePerfPanel(ts);

    const stillMoving = Math.abs(targetProgress - progress) > config.settleThreshold ||
      Math.abs(desiredProgress - targetProgress) > config.settleThreshold ||
      (isNativeScroll && Math.abs(mobileNativeProgress - desiredProgress) > config.settleThreshold) ||
      Math.abs(inputVelocity) > 0.00001 ||
      Math.abs(targetTime - currentTime) > 0.002;

    rafId = stillMoving ? requestAnimationFrame(loop) : null;
  }

  function startLoop() {
    if (!rafId) rafId = requestAnimationFrame(loop);
  }

  function normalizeWheelDelta(event) {
    const modeMultiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
    const delta = event.deltaY * modeMultiplier;
    return Math.sign(delta) * Math.min(Math.abs(delta), config.wheelDeltaCap);
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
    setProgress(desiredProgress + delta * config.touchSensitivity);
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
    const response = await fetch(config.manifestPath, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Manifest non trovato: ${config.manifestPath}`);
    return response.json();
  }

  function preloadFirstAsset(url) {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'image';
    link.href = url;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }

  function loadImage(src, highPriority = false) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = 'async';
      image.crossOrigin = 'anonymous';
      if ('fetchPriority' in image) image.fetchPriority = highPriority ? 'high' : 'low';
      image.onload = async () => {
        try {
          if (image.decode) await image.decode();
        } catch (_) {
          // decode() può fallire su immagini già decodificate: onload resta sufficiente.
        }
        resolve(image);
      };
      image.onerror = () => reject(new Error(`Frame non caricato: ${src}`));
      image.src = src;
    });
  }

  async function requestFrameLoad(index, highPriority = false) {
    if (index < 0 || index >= frameCount) return null;
    if (frames[index]) return frames[index];
    if (loadingFrames.has(index)) return loadingFrames.get(index);

    const promise = loadImage(framePaths[index], highPriority)
      .then((image) => {
        frames[index] = image;
        loadedFrames += 1;
        const percent = Math.round((loadedFrames / frameCount) * 100);
        if (!body.classList.contains('is-ready')) setLoader(`Caricamento frame ${percent}%`);
        if (isNativeScroll && index === getFrameIndexForProgress(progress)) {
          lastRenderedFrame = -1;
          startLoop();
        }
        return image;
      })
      .finally(() => {
        loadingFrames.delete(index);
      });

    loadingFrames.set(index, promise);
    return promise;
  }

  function requestLookAhead(center) {
    const start = Math.max(0, center - Math.floor(config.lookAheadFrames / 3));
    const end = Math.min(frameCount - 1, center + config.lookAheadFrames);
    for (let i = start; i <= end; i += 1) requestFrameLoad(i, false);
  }

  async function preloadCriticalFrames() {
    criticalFrames = Math.max(8, Math.ceil(frameCount * config.initialPreloadRatio));
    const indices = new Set([0, frameCount - 1]);

    for (let i = 0; i < criticalFrames; i += 1) indices.add(i);
    for (let p = 0.20; p <= 0.80; p += 0.20) indices.add(Math.round((frameCount - 1) * p));

    const ordered = [...indices].sort((a, b) => a - b);
    let cursor = 0;

    const worker = async () => {
      while (cursor < ordered.length) {
        const index = ordered[cursor++];
        await requestFrameLoad(index, index === 0);
        if (index === 0) drawFrameForProgress(0, true);
      }
    };

    await Promise.all(Array.from({ length: Math.min(config.preloadConcurrency, ordered.length) }, worker));
  }

  function preloadBackgroundFrames() {
    let index = 0;
    const batch = () => {
      let count = 0;
      while (index < frameCount && count < config.backgroundBatchSize) {
        requestFrameLoad(index, false);
        index += 1;
        count += 1;
      }
      if (index < frameCount) {
        if ('requestIdleCallback' in window) requestIdleCallback(batch, { timeout: 800 });
        else setTimeout(batch, 120);
      }
    };
    batch();
  }

  async function initCanvasMode() {
    manifest = await loadManifest();
    if (!manifest.frames || !manifest.frames.length) throw new Error('Manifest frame vuoto');

    framePaths = manifest.frames.map(resolveAssetUrl);
    frameCount = framePaths.length;
    frames = new Array(frameCount);

    preloadFirstAsset(framePaths[0]);
    initWebGL();
    resizeCanvas();
    await preloadCriticalFrames();

    canvasReady = true;
    usingVideoFallback = false;
    body.classList.remove('is-video-fallback');
    body.classList.add('is-ready');
    drawFrameForProgress(progress, true);
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
    if (!video.src) video.src = resolveAssetUrl(video.dataset.src || 'crow-threshold-scrub.mp4');
    video.addEventListener('loadedmetadata', prepareFallback, { once: true });
    video.addEventListener('canplay', prepareFallback, { once: true });
    video.addEventListener('play', () => video.pause());
    video.load();
  }

  function initEvents() {
    if (isNativeScroll) {
      const syncNativeViewport = () => {
        const shouldResetScrollDistance = window.innerWidth !== stableViewportWidth;
        cancelAnimationFrame(resizeRaf);
        resizeRaf = requestAnimationFrame(() => {
          applyStableMobileViewport(shouldResetScrollDistance);
          resizeCanvas();
          mobileNativeProgress = getNativeScrollProgress();
          startLoop();
        });
      };

      window.addEventListener('scroll', onNativeScroll, { passive: true });
      window.addEventListener('resize', syncNativeViewport, { passive: true });
      window.addEventListener('orientationchange', () => setTimeout(syncNativeViewport, 250), { passive: true });

      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncNativeViewport, { passive: true });
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
    }, { passive: true });
  }

  function createPerfPanel() {
    if (!DEBUG) return;
    perfPanel = document.createElement('div');
    perfPanel.className = 'perf-panel';
    document.body.appendChild(perfPanel);
  }

  function updatePerfPanel(ts) {
    if (!perfPanel || ts - lastPerfUpdate < 250) return;
    lastPerfUpdate = ts;
    const memory = performance.memory ? `${Math.round(performance.memory.usedJSHeapSize / 1048576)}MB` : 'n/a';
    perfPanel.textContent = [
      `quality: ${degraded ? 'low/degraded' : quality}`,
      `renderer: ${usingVideoFallback ? 'video' : renderer}`,
      `frames: ${loadedFrames}/${frameCount}`,
      `progress: ${progress.toFixed(3)}`,
      `dpr cap: ${config.maxDevicePixelRatio}`,
      `heap: ${memory}`,
    ].join('\n');
  }

  async function init() {
    createPerfPanel();

    if (isNativeScroll) {
      applyStableMobileViewport();
      mobileNativeProgress = getNativeScrollProgress();
      desiredProgress = mobileNativeProgress;
      targetProgress = desiredProgress;
      progress = desiredProgress;
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

  function initWhenUseful() {
    if (!('IntersectionObserver' in window)) {
      init();
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
        observer.disconnect();
        init();
      }
    }, { root: null, rootMargin: '250px', threshold: 0.01 });

    observer.observe(stage);
  }

  initWhenUseful();
})();
