"use client";
import React, { useEffect, useRef, useState } from "react";
import Image from "next/image";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import SplitText from "gsap/dist/SplitText";
import ClipPath from "../ClipPath";
import { APP_URL } from "@/config/links";
import { useWaitlist } from "@/components/waitlist/Waitlist";

gsap.registerPlugin(ScrollTrigger, SplitText);

// Material speaker icons (sound off and sound on).
const SOUND_OFF_PATH =
  "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z";
const SOUND_ON_PATH =
  "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z";

const Hero = () => {
  const waitlist = useWaitlist();
  const videoRef = useRef(null);
  const videoElRef = useRef(null);
  const cursorRef = useRef(null);
  const clipRef = useRef(null);
  const heroRef = useRef(null);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isMuted, setIsMuted] = useState(true);
  const [videoProgress, setVideoProgress] = useState(0);
  const [isCursorVisible, setIsCursorVisible] = useState(false);
  // True while the browser has blocked sound and the video plays muted until the visitor interacts.
  const [needsTap, setNeedsTap] = useState(false);
  // The visitor muted the video on purpose: never unmute it for them.
  const userMutedRef = useRef(false);
  // Paused by us because the hero left the screen, so it resumes when it comes back.
  const autoPausedRef = useRef(false);
  // Phones and tablets toggle sound by tapping the video. Set after mount so the server render and
  // the first client render agree.
  const [tapTogglesSound, setTapTogglesSound] = useState(false);
  useEffect(() => setTapTogglesSound(window.innerWidth < 1024), []);
  // False once the film fails to load (or is not there yet): the poster stays and the playback
  // controls hide.
  const [hasVideo, setHasVideo] = useState(true);
  // Matches Tailwind's lg breakpoint, where the layout switches to the phone and tablet hero.
  const isMobile = globalThis.innerWidth < 1024;

  const isFullyScaled = scrollProgress >= 0.85;
  const controlsOpacity = Math.min(1, Math.max(0, (scrollProgress - 0.65) / 0.2));

  // A missing or unplayable film: keep the poster, drop the controls. The error can fire before
  // hydration, so the element's state is read once on mount too.
  useEffect(() => {
    const video = videoElRef.current;
    if (!video) return;
    const fail = () => setHasVideo(false);
    if (video.error || video.networkState === HTMLMediaElement.NETWORK_NO_SOURCE) fail();
    video.addEventListener("error", fail);
    return () => video.removeEventListener("error", fail);
  }, []);

  // Track video playback progress
  useEffect(() => {
    const video = videoElRef.current;
    if (!video) return;

    const onTimeUpdate = () => {
      if (video.duration) {
        setVideoProgress((video.currentTime / video.duration) * 100);
      }
    };
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onVolumeChange = () => setIsMuted(video.muted);

    video.addEventListener("timeupdate", onTimeUpdate);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("volumechange", onVolumeChange);

    return () => {
      video.removeEventListener("timeupdate", onTimeUpdate);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  }, []);

  // Play with sound. Browsers block unmuted autoplay until the visitor has interacted with the
  // site, so when play() is refused the video starts muted and a "Tap for sound" control shows.
  useEffect(() => {
    const video = videoElRef.current;
    if (!video) return;
    let cancelled = false;
    video.muted = false;
    video.play().then(
      () => {
        if (!cancelled) setIsMuted(false);
      },
      () => {
        if (cancelled) return;
        video.muted = true;
        setIsMuted(true);
        setNeedsTap(true);
        video.play().catch(() => {});
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // While sound is blocked, the first click, tap or key press anywhere on the page turns it on.
  // Sound controls handle their own clicks, so they are skipped here.
  useEffect(() => {
    if (!needsTap) return;
    const events = ["pointerdown", "touchend", "click", "keydown"];
    const unmute = (e) => {
      if (e.target instanceof Element && e.target.closest("[data-video-sound]")) return;
      // Unmuting without a user activation makes the browser pause the video, so wait for one.
      if (navigator.userActivation && !navigator.userActivation.isActive) return;
      const video = videoElRef.current;
      if (!video || userMutedRef.current) return;
      video.muted = false;
      if (video.paused && !autoPausedRef.current) video.play().catch(() => {});
      setNeedsTap(false);
    };
    events.forEach((t) => window.addEventListener(t, unmute, { capture: true }));
    return () => events.forEach((t) => window.removeEventListener(t, unmute, { capture: true }));
  }, [needsTap]);

  // Pause while the hero is off screen, so the sound does not follow the visitor down the page.
  useEffect(() => {
    const hero = heroRef.current;
    const video = videoElRef.current;
    if (!hero || !video || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting && !video.paused) {
        autoPausedRef.current = true;
        video.pause();
      } else if (entry.isIntersecting && autoPausedRef.current) {
        autoPausedRef.current = false;
        video.play().catch(() => {});
      }
    });
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const ctx = gsap.context(() => {
      const tl = gsap.timeline();

      const splitHero = new SplitText(".hero-text", {
        type: "lines",
        aria: "none",
        linesClass: "lines",
        mask: "lines",
      });

      gsap.set(".hero-veil", {
        delay: 0.2,
        opacity: 0,
      });

      tl.from(splitHero.lines, {
        yPercent: 100,
        opacity: 0,
        stagger: 0.2,
        duration: 1,
        delay: 1,
        ease: "power3.out",
      });

      if (!isMobile) {
        gsap.fromTo(
          ".hero-video",
          { scale: 1 / 3, rotateX: baseRotateX, rotateY: baseRotateY, borderRadius: "4.5vw" },
          {
            scale: 1,
            rotateX: 0,
            rotateY: 0,
            borderRadius: "0vw",
            ease: "power2.out",
            scrollTrigger: {
              trigger: "#hero",
              start: "top top",
              end: "bottom bottom",
              scrub: 0.3,
              immediateRender: false,
              onUpdate: (self) => {
                setScrollProgress(self.progress);
              },
            },
          },
        );
      } else {
        gsap.set(".hero-video", { scale: 1, rotateX: 0, rotateY: 0, clearProps: "transform" });
      }

      tl.to(videoRef.current, { opacity: 1 }, "-=0.5");

      // The calls to action rise in after the headline, unless motion is reduced.
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        gsap.from(".hero-cta", { opacity: 0, y: 16, duration: 0.8, delay: 1.6, ease: "power3.out" });
      }
    });
    return () => ctx.revert();
  }, []);

  const baseRotateX = 5;
  const baseRotateY = -5;

  const togglePlayPause = () => {
    const video = videoElRef.current;
    if (!video) return;
    // The first click on a muted autoplay turns the sound on rather than pausing.
    if (needsTap) {
      turnSoundOn();
      return;
    }
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  };

  const turnSoundOn = () => {
    const video = videoElRef.current;
    if (!video) return;
    userMutedRef.current = false;
    video.muted = false;
    if (video.paused) video.play().catch(() => {});
    setIsMuted(false);
    setNeedsTap(false);
  };

  const toggleMute = () => {
    const video = videoElRef.current;
    if (!video) return;
    video.muted = !video.muted;
    userMutedRef.current = video.muted;
    if (!video.muted && video.paused) video.play().catch(() => {});
    setIsMuted(video.muted);
    setNeedsTap(false);
  };

  const handleProgressClick = (e) => {
    const video = videoElRef.current;
    if (!video) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    video.currentTime = ratio * video.duration;
  };

  // Custom cursor follows mouse when video is fullscreen
  const handleCursorMove = (e) => {
    if (!cursorRef.current) return;
    gsap.to(cursorRef.current, {
      x: e.clientX,
      y: e.clientY,
      duration: 0.4,
      ease: "power2.out",
      overwrite: "auto",
    });
  };

  const handleMouseMove = (e) => {
    if (isFullyScaled) return;

    const video = videoRef.current;
    const clip = clipRef.current;
    const hero = heroRef.current;
    if (!video || !clip || !hero) return;

    const { left, top, width, height } = hero.getBoundingClientRect();
    const x = e.clientX - left;
    const y = e.clientY - top;

    const normX = (x - width / 2) / (width / 2);
    const normY = (y - height / 2) / (height / 2);

    gsap.to(video, {
      rotateX: baseRotateX - normY * 10,
      rotateY: baseRotateY + normX * 10,
      duration: 0.3,
      ease: "power2.out",
      overwrite: "auto",
    });

    gsap.to(clip, {
      rotateX: baseRotateX + normY * 15,
      rotateY: baseRotateY - normX * 15,
      duration: 0.3,
      ease: "power2.out",
      overwrite: "auto",
    });
  };

  const handleMouseLeave = () => {
    if (isFullyScaled) return;

    const video = videoRef.current;
    const clip = clipRef.current;
    if (video && clip) {
      gsap.to(video, {
        rotateX: baseRotateX,
        rotateY: baseRotateY,
        duration: 0.5,
        ease: "power2.out",
        overwrite: "auto",
      });
      gsap.to(clip, {
        rotateX: baseRotateX,
        rotateY: baseRotateY,
        duration: 0.5,
        ease: "power2.out",
        overwrite: "auto",
      });
    }
  };

  return (
    <section
      ref={heroRef}
      id="hero"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className="w-screen h-[200vh] max-lg:h-screen bg-black relative"
    >
      {/* A lavender veil over the first paint, lifted once the page has loaded. */}
      <div className="fixed inset-0 bg-[#9C93E8] pointer-events-none h-full w-full hero-veil z-[99999]"></div>

      <div className="h-screen w-full max-lg:w-screen sticky top-0 max-lg:left-0 overflow-hidden flex justify-center items-center">
        {/* Below lg the headline, the picture and the intro stack in one screen; a wide but short window (600 px and up, 920 px tall or less) shrinks the picture and the headline so they never overlap. */}
        <div
          ref={videoRef}
          className="h-[60vw] w-[102vw] max-lg:h-[25vh] max-lg:[@media(min-width:600px)_and_(max-height:920px)]:h-[18vh] max-lg:mx-auto max-lg:w-[90vw] opacity-0 hero-video relative z-40 rounded-[4.5vw] overflow-hidden shadow-2xl origin-center max-lg:rounded-[3.5vw]"
          style={{ transformStyle: "preserve-3d", willChange: "transform" }}
          onClick={tapTogglesSound && hasVideo ? toggleMute : undefined}
          data-video-sound={tapTogglesSound && hasVideo ? "" : undefined}
        >
          {/* Started from script, with sound when the browser allows it (see the effects above). */}
          <video
            ref={videoElRef}
            src="/assets/video/hero-vid.mp4"
            poster="/assets/video/hero-poster.webp"
            preload="auto"
            loop
            playsInline
            aria-label="Tredio product film"
            className="w-full h-full object-cover"
          />
          {/* Mobile mute indicator */}
          <div className={`absolute inset-0 hidden ${hasVideo ? "max-lg:flex" : ""} items-end justify-end p-3 pointer-events-none`}>
            <div className="w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
              {isMuted ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                  <path d={SOUND_OFF_PATH} />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                  <path d={SOUND_ON_PATH} />
                </svg>
              )}
            </div>
          </div>
        </div>

        <ClipPath clipRef={clipRef} />

        {/* TEXT LAYER */}
        <div className="absolute inset-0 h-screen w-full flex items-center max-lg:flex-col max-lg:items-start max-lg:justify-between max-lg:pt-[clamp(84px,18vw,120px)] max-lg:pb-[10vw] text-[#101417] justify-between z-20 px-[3vw] max-lg:px-[5vw]">
          <div>
            <h1 className="text-[2.5vw] max-lg:text-[clamp(36px,10vw,64px)] max-lg:[@media(min-width:600px)_and_(max-height:920px)]:text-[clamp(32px,6vw,48px)] max-lg:text-white max-lg:[text-shadow:0_1px_14px_rgba(0,0,0,0.5)] font-third leading-[1.1] hero-text max-lg:text-left">
              Trade the World&apos;s <br /> Attention
            </h1>
            <div className="hero-cta mt-[1.7vw] flex flex-wrap items-center gap-[0.6vw] max-lg:mt-5 max-lg:gap-2.5">
              <a
                href={APP_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-[clamp(36px,2.9vw,52px)] items-center rounded-[clamp(4px,0.35vw,7px)] bg-[#101417] px-[clamp(14px,1.3vw,24px)] font-body text-[clamp(11px,0.75vw,14px)] font-semibold uppercase tracking-[0.12em] text-white transition-colors hover:bg-black max-lg:h-11 max-lg:rounded-full max-lg:bg-[#9C93E8] max-lg:px-5 max-lg:text-[12px] max-lg:text-black"
              >
                Launch App
              </a>
              <button
                type="button"
                onClick={waitlist.open}
                className="inline-flex h-[clamp(36px,2.9vw,52px)] cursor-pointer items-center rounded-[clamp(4px,0.35vw,7px)] border border-[#101417]/60 px-[clamp(14px,1.3vw,24px)] font-body text-[clamp(11px,0.75vw,14px)] font-semibold uppercase tracking-[0.12em] text-[#101417] transition-colors hover:border-[#101417] hover:bg-[#101417]/[0.06] max-lg:h-11 max-lg:rounded-full max-lg:border-white/45 max-lg:bg-black/35 max-lg:px-5 max-lg:text-[12px] max-lg:text-white max-lg:backdrop-blur-sm"
                data-testid="hero-waitlist"
              >
                Join the waitlist
              </button>
            </div>
          </div>
          <p className="w-[23%] max-lg:w-full max-lg:text-[clamp(15px,4vw,20px)] max-lg:leading-[1.5] max-lg:text-left max-lg:mb-12 max-lg:bg-black/65 max-lg:backdrop-blur-sm max-lg:rounded-2xl max-lg:px-4 max-lg:py-3 text-[1.3vw] leading-[1.35] hero-text text-white">
            When something starts trending, Tredio opens a market on it. Trade where the attention goes next, with one passkey and no gas.
          </p>
        </div>

        {/* CUSTOM CURSOR PLAY/PAUSE: visible when video is fullscreen */}
        <div
          className="absolute inset-0 z-50 max-lg:hidden"
          style={{
            cursor: isFullyScaled && hasVideo ? "none" : "default",
            pointerEvents: isFullyScaled && hasVideo ? "auto" : "none",
          }}
          onClick={isFullyScaled && hasVideo ? togglePlayPause : undefined}
          data-video-sound=""
          onMouseMove={isFullyScaled ? handleCursorMove : undefined}
          onMouseEnter={() => isFullyScaled && setIsCursorVisible(true)}
          onMouseLeave={() => setIsCursorVisible(false)}
        />

        <div
          ref={cursorRef}
          className="fixed pointer-events-none z-[60] w-[4vw] h-[4vw] rounded-full bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center text-white text-[0.65vw] font-semibold font-display uppercase tracking-[0.2em] max-lg:hidden"
          style={{
            left: 0,
            top: 0,
            transform: "translate(-50%, -50%)",
            opacity: isCursorVisible && isFullyScaled && hasVideo ? 1 : 0,
            transition: "opacity 0.2s ease",
          }}
        >
          {needsTap ? (
            <svg width="1.5vw" height="1.5vw" viewBox="0 0 24 24" fill="white" aria-hidden="true">
              <path d={SOUND_ON_PATH} />
            </svg>
          ) : isPlaying ? (
            <svg width="1.5vw" height="1.5vw" viewBox="0 0 24 24" fill="white">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="1.5vw" height="1.5vw" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </div>

        {/* BOTTOM CONTROLS BAR: progress + mute side by side */}
        {hasVideo && (
          <div
            className="absolute bottom-0 left-0 right-0 z-50 px-8 pb-8 flex flex-row items-center gap-4 max-lg:hidden pointer-events-none"
            style={{ opacity: controlsOpacity }}
          >
            {/* Progress bar */}
            <div
              className="flex-1 h-[3px] bg-white/20 rounded-full cursor-pointer group"
              onClick={handleProgressClick}
              style={{ pointerEvents: controlsOpacity > 0.1 ? "auto" : "none" }}
            >
              <div
                className="h-full bg-white rounded-full relative"
                style={{ width: `${videoProgress}%` }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>

            {/* Mute toggle */}
            <button
              type="button"
              data-video-sound=""
              onClick={toggleMute}
              className="w-10 h-10 shrink-0 rounded-full bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center transition-transform hover:scale-110 active:scale-95"
              style={{ pointerEvents: controlsOpacity > 0.1 ? "auto" : "none" }}
              aria-label={isMuted ? "Unmute video" : "Mute video"}
            >
              {isMuted ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                  <path d={SOUND_OFF_PATH} />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
                  <path d={SOUND_ON_PATH} />
                </svg>
              )}
            </button>
          </div>
        )}

        {/* TAP FOR SOUND: shown while the browser keeps the video muted */}
        {needsTap && hasVideo && (
          <button
            type="button"
            data-video-sound=""
            onClick={turnSoundOn}
            className={`absolute left-1/2 -translate-x-1/2 ${isFullyScaled ? "bottom-20" : "top-[calc(50%+11.5vw)]"} max-lg:top-[calc(50%+12.5vh+14px)] max-lg:[@media(min-width:600px)_and_(max-height:920px)]:top-[calc(50%+9vh+14px)] max-lg:bottom-auto z-[55] flex items-center gap-2 rounded-full bg-black/55 backdrop-blur-md border border-white/25 px-4 py-2 text-white font-body font-semibold uppercase tracking-[0.14em] text-[11px] shadow-lg cursor-pointer transition-transform hover:scale-105 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="white" aria-hidden="true">
              <path d={SOUND_ON_PATH} />
            </svg>
            Tap for sound
          </button>
        )}

        {/* SVG DECORATION */}
        <div className="absolute bottom-5 max-lg:bottom-0 left-0 w-full h-[25%] max-lg:h-[15%] px-[2vw]">
          <Image
            width={1000}
            height={1000}
            src="/assets/svg/home-hero.svg"
            alt=""
            aria-hidden="true"
            className="absolute bottom-5 max-lg:bottom-[-5vw] left-0 w-full h-full max-lg:px-4 object-contain mix-blend-color-burn opacity-90 z-10"
          />
          <Image
            width={1000}
            height={1000}
            src="/assets/svg/home-hero.svg"
            alt=""
            aria-hidden="true"
            className="absolute bottom-5 max-lg:bottom-[-5vw] left-0 w-full h-full max-lg:px-4 object-contain mix-blend-color-burn opacity-90 z-10"
          />
        </div>

        {/* LIGHT OVERLAY */}
        <div className="w-full h-full absolute inset-0 z-15 bg-black/5" />
      </div>
    </section>
  );
};

export default Hero;
