const video = document.querySelector("#scrollVideo");
const section = document.querySelector("#scrubSection");

let duration = 0;
let targetTime = 0;
let currentTime = 0;
let isReady = false;
let isTicking = false;
const scrubStart = 0;
const smoothing = 0.08;
const introRatio = 0.08;
const outroRatio = 0.08;
const root = document.documentElement;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function getScrollProgress() {
  const sectionTop = section.offsetTop;
  const scrollableDistance = section.offsetHeight - window.innerHeight;

  if (scrollableDistance <= 0) {
    return 0;
  }

  return clamp((window.scrollY - sectionTop) / scrollableDistance, 0, 1);
}

function renderFrame() {
  const progress = getScrollProgress();
  const videoStart = introRatio;
  const videoEnd = 1 - outroRatio;
  const blackOpacity = clamp(1 - progress / introRatio, 0, 1);
  const whiteOpacity = clamp((progress - videoEnd) / outroRatio, 0, 1);

  root.style.setProperty("--black-opacity", blackOpacity.toFixed(3));
  root.style.setProperty("--white-opacity", whiteOpacity.toFixed(3));

  if (!isReady) {
    isTicking = false;
    return;
  }

  const scrubEnd = Math.max(duration - 0.04, scrubStart);
  const videoProgress = clamp((progress - videoStart) / (videoEnd - videoStart), 0, 1);
  targetTime = scrubStart + videoProgress * (scrubEnd - scrubStart);
  currentTime += (targetTime - currentTime) * smoothing;

  if (Math.abs(video.currentTime - currentTime) > 0.005) {
    video.currentTime = currentTime;
  }

  if (Math.abs(targetTime - currentTime) > 0.001) {
    requestAnimationFrame(renderFrame);
    return;
  }

  isTicking = false;
}

function requestFrame() {
  if (!isTicking) {
    isTicking = true;
    requestAnimationFrame(renderFrame);
  }
}

function prepareVideo() {
  duration = video.duration || 0;
  currentTime = video.currentTime || 0;
  isReady = duration > 0;
  video.pause();
  requestFrame();
}

video.addEventListener("loadedmetadata", prepareVideo);
video.addEventListener("canplay", prepareVideo, { once: true });
video.addEventListener("play", () => video.pause());
window.addEventListener("scroll", requestFrame, { passive: true });
window.addEventListener("resize", requestFrame);

video.pause();
