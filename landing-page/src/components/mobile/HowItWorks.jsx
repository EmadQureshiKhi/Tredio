"use client";
import React, { useState, useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { gsap } from "gsap";
import Image from "next/image";
import { APP_URL } from "@/config/links";

const HighlightedProjects = () => {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [nextSlide, setNextSlide] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const overlayRef = useRef(null);
  const currentTextRef = useRef(null);
  const isFirstMount = useRef(true);

  const slides = [
    {
      id: 1,
      ticker: "BTC",
      assetClass: "Crypto",
      network: "Testnet",
      quote: "Bitcoin is all over the feed. Will its attention index end the day above where it opened? Buy UP or DOWN on the order book: each winning token redeems for 1 USDC, and each losing token for nothing.",
      bgImage: "/assets/img/topics-trend-every-day.jpg",
    },
    {
      id: 2,
      ticker: "HANTA",
      assetClass: "Topic",
      network: "Testnet",
      quote: "A news cycle has no ticker, but its attention does. Go long while the story spreads, or short it as the feed moves on, with an attention perp.",
      bgImage: "/assets/img/hantavirus.avif",
    },
    {
      id: 3,
      ticker: "AAPL",
      assetClass: "Equity",
      network: "Testnet",
      quote: "Keynote day. Back the conversation early with the trend's own coin on its bonding curve, or trade its attention Up or Down.",
      bgImage: "/assets/img/apple-keynote.jpg",
    },
  ];

  // Runs synchronously after DOM update, so GSAP targets the actual new nodes
  useLayoutEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      return;
    }
    const els = currentTextRef.current?.querySelectorAll(".highlight-project-text");
    if (!els?.length) return;
    gsap.fromTo(
      els,
      { opacity: 0, y: 20 },
      { opacity: 1, y: 0, stagger: 0.05, duration: 0.4, ease: "power2.out" }
    );
  }, [currentSlide]);

  const animateSlideChange = (direction) => {
    if (isAnimating) return;
    setIsAnimating(true);

    const nextIndex =
      direction === "next"
        ? currentSlide === slides.length - 1 ? 0 : currentSlide + 1
        : currentSlide === 0 ? slides.length - 1 : currentSlide - 1;

    // Update overlay background synchronously so next slide image is ready
    flushSync(() => setNextSlide(nextIndex));

    // Capture current elements BEFORE any state updates
    const currentEls = Array.from(
      currentTextRef.current.querySelectorAll(".highlight-project-text")
    );

    const tl = gsap.timeline({
      onComplete: () => {
        // flushSync forces synchronous React re-render → useLayoutEffect fades in new text
        flushSync(() => {
          setCurrentSlide(nextIndex);
          setIsAnimating(false);
        });
      },
    });

    // 1. Exit current text
    tl.to(currentEls, {
      opacity: 0,
      y: -16,
      stagger: 0.02,
      duration: 0.25,
      ease: "power2.in",
    });

    // 2. Overlay wipes open (reveals next slide background)
    tl.to(
      overlayRef.current,
      {
        clipPath: "polygon(100% 50%, 100% 100%, 100% 100%, 0% 50%, 100% 0%, 100% 0%)",
        duration: 0.4,
        ease: "power2.in",
      },
      "-=0.1"
    ).to(overlayRef.current, {
      clipPath: "polygon(100% 50%, 100% 100%, 0% 100%, 0% 50%, 0% 0%, 100% 0%)",
      duration: 0.4,
      ease: "power2.out",
    });

    // 3. Brief hold so user sees next slide background
    tl.to({}, { duration: 0.15 });

    // 4. Ensure current layer is hidden before overlay closes (no flash of old content)
    tl.add(() => gsap.set(currentEls, { opacity: 0, y: 0 }));

    // 5. Overlay wipes closed
    tl.to(overlayRef.current, {
      clipPath: "polygon(100% 50%, 100% 50%, 100% 50%, 0% 50%, 100% 50%, 100% 50%)",
      duration: 0,
    });

    // onComplete: flushSync setCurrentSlide → React updates DOM → useLayoutEffect animates text in
  };

  return (
    <div className="relative w-full h-screen overflow-hidden">
      {/* Current Slide */}
      <div
        className="absolute inset-0 w-full h-full"
        style={{
          backgroundImage: `url(${slides[currentSlide].bgImage})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" />

        <div
          ref={currentTextRef}
          className="relative z-10 flex flex-col justify-center h-full px-8 pb-20"
        >
          <div className="absolute top-16 left-8">
            <p className="text-white/60 font-display text-xs tracking-[0.3em] uppercase">
              Example markets
            </p>
          </div>

          <div className="flex flex-col gap-8">
            <div className="flex gap-3">
              <span className="highlight-project-text px-2.5 py-1 bg-[#9C93E8]/10 border border-[#9C93E8]/20 rounded text-[#9C93E8] text-[10px] font-bold uppercase tracking-wider">
                {slides[currentSlide].assetClass}
              </span>
              <span className="highlight-project-text px-2.5 py-1 bg-white/5 border border-white/10 rounded text-white/50 text-[10px] font-bold uppercase tracking-wider">
                {slides[currentSlide].network}
              </span>
            </div>

            <h2 className="highlight-project-text text-white text-6xl font-bold leading-none tracking-tighter">
              {slides[currentSlide].ticker}
              <span className="text-[#9C93E8]">.</span>
            </h2>

            <p className="highlight-project-text text-white/85 text-lg font-medium leading-snug">
              {slides[currentSlide].quote}
            </p>
          </div>
        </div>
      </div>

      {/* Wipe Overlay: shows next slide background only, no text to avoid DOM race */}
      <div
        ref={overlayRef}
        className="absolute inset-0 w-full h-full pointer-events-none z-20"
        style={{
          clipPath: "polygon(100% 50%, 100% 50%, 100% 50%, 0% 50%, 100% 50%, 100% 50%)",
          backgroundImage: `url(${slides[nextSlide].bgImage})`,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" />
      </div>

      {/* Navigation & CTA */}
      <div className="absolute bottom-12 left-0 right-0 z-40 px-8">
        <div className="flex items-center justify-between">
          <a
            href={APP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-[#9C93E8] text-black px-8 py-4 rounded-full font-bold text-[11px] tracking-[0.2em] uppercase active:scale-95 transition-transform"
          >
            Open App
          </a>

          <div className="flex gap-4">
            <button
              onClick={() => animateSlideChange("prev")}
              aria-label="Previous market"
              disabled={isAnimating}
              className="w-14 h-14 rounded-full bg-white/5 border border-white/10 backdrop-blur-xl flex items-center justify-center active:bg-white/10 transition-colors"
            >
              <Image src="/assets/icons/prev-icon.svg" width={24} height={24} alt="" className="w-6 h-6 invert" />
            </button>
            <button
              onClick={() => animateSlideChange("next")}
              aria-label="Next market"
              disabled={isAnimating}
              className="w-14 h-14 rounded-full bg-white/5 border border-white/10 backdrop-blur-xl flex items-center justify-center active:bg-white/10 transition-colors"
            >
              <Image src="/assets/icons/next-icon.svg" width={24} height={24} alt="" className="w-6 h-6 invert" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HighlightedProjects;
