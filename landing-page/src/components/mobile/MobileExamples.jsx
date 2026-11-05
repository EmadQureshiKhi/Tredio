"use client";
import React, { useState, useRef, useEffect } from "react";
import { gsap } from "gsap";
import { SplitText } from "gsap/SplitText";
import Image from "next/image";
import { APP_URL } from "@/config/links";
import { EXAMPLES } from "@/config/content";

gsap.registerPlugin(SplitText);

// Example markets on phones: facts, the pitch and the market card, one market at a time.
const ExamplesMobile = () => {
  const slides = EXAMPLES;
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const currentTextRef = useRef(null);

  const animateTextIn = () => {
    const split = new SplitText(currentTextRef.current.querySelectorAll(".case-study-text"), {
      type: "lines",
      aria: "none",
      linesClass: "line",
    });
    gsap.set(split.lines, { yPercent: 100, opacity: 0 });
    gsap.to(split.lines, { yPercent: 0, opacity: 1, stagger: 0.04, duration: 0.4, ease: "power2.out" });
    gsap.fromTo(currentTextRef.current.querySelector(".case-study-image"), { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power2.out" });
  };

  const animateSlideChange = (direction) => {
    if (isAnimating) return;
    setIsAnimating(true);
    const nextIndex = direction === "next" ? (currentSlide + 1) % slides.length : (currentSlide - 1 + slides.length) % slides.length;
    const oldSplit = new SplitText(currentTextRef.current.querySelectorAll(".case-study-text"), {
      type: "lines",
      aria: "none",
      linesClass: "line",
    });
    const tl = gsap.timeline({ onComplete: () => setCurrentSlide(nextIndex) });
    tl.to(oldSplit.lines, { yPercent: -100, opacity: 0, stagger: 0.04, duration: 0.4, ease: "power2.inOut" }).to(
      currentTextRef.current.querySelector(".case-study-image"),
      { opacity: 0, duration: 0.3, ease: "power2.inOut" },
      "<",
    );
  };

  useEffect(() => {
    const ctx = gsap.context(() => {
      animateTextIn();
    });
    const timeout = setTimeout(() => setIsAnimating(false), 800);
    return () => {
      ctx.revert();
      clearTimeout(timeout);
    };
  }, [currentSlide]);

  const slide = slides[currentSlide];
  const facts = [
    ["Market", slide.ticker],
    ["Asset class", slide.assetClass],
    ["Market type", slide.marketType],
    ["Network", slide.network],
  ];

  return (
    <section id="examples" aria-label="Example markets" className="relative w-full bg-white px-6 py-14">
      <style jsx>{`
        .line {
          overflow: hidden;
          display: block;
        }
      `}</style>

      <div className="mx-auto max-w-md">
        <p className="font-body text-[12px] font-semibold uppercase tracking-[0.18em] text-black/55">Example markets</p>
        <div ref={currentTextRef} key={`slide-${currentSlide}`} className="relative mt-8">
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 mb-8">
            {facts.map(([label, value]) => (
              <div key={label}>
                <p className="font-body text-[11px] font-semibold uppercase tracking-[0.14em] text-black/55 mb-1">{label}</p>
                <p className="case-study-text text-[17px] font-medium uppercase tracking-[0.04em] text-gray-900">{value}</p>
              </div>
            ))}
          </div>

          <p className="case-study-text text-[clamp(24px,6.6vw,34px)] leading-[1.22] text-neutral-900 font-display mb-8">{slide.quote}</p>

          <Image
            src={slide.image}
            alt={slide.alt}
            width={1600}
            height={1000}
            sizes="88vw"
            className="case-study-image w-full aspect-[8/5] object-cover rounded-2xl mb-8"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="font-body text-[13px] font-semibold tracking-[0.12em] text-neutral-900 tabular-nums">
            {String(currentSlide + 1).padStart(2, "0")} / {String(slides.length).padStart(2, "0")}
          </span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => animateSlideChange("prev")}
              aria-label="Previous market"
              disabled={isAnimating}
              className="flex size-11 items-center justify-center rounded-full border border-gray-300 transition-colors duration-300 disabled:opacity-50"
            >
              <Image src="/assets/icons/prev-icon.svg" width={20} height={20} alt="" className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => animateSlideChange("next")}
              aria-label="Next market"
              disabled={isAnimating}
              className="flex size-11 items-center justify-center rounded-full border border-gray-300 transition-colors duration-300 disabled:opacity-50"
            >
              <Image src="/assets/icons/next-icon.svg" width={20} height={20} alt="" className="size-5" />
            </button>
          </div>
        </div>
        <a
          href={APP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 flex h-12 w-full items-center justify-center rounded-full bg-[#9C93E8] font-body text-[13px] font-semibold uppercase tracking-[0.14em] text-black"
        >
          Open the market
        </a>
      </div>
    </section>
  );
};

export default ExamplesMobile;
