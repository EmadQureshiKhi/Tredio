"use client";
import React, { useEffect, useState } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/dist/ScrollTrigger";
import SplitText from "gsap/dist/SplitText";
import IconButton from "../button/IconButton";
import Btn from "../button/Btn";
import Image from "next/image";
import { APP_URL } from "@/config/links";
import { EXAMPLES } from "@/config/content";
gsap.registerPlugin(ScrollTrigger, SplitText);

// Example markets: a white panel that opens from the left as it scrolls in, one market at a time.
const Examples = () => {
  const slides = EXAMPLES;
  const [current, setCurrent] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.set(".examples-panel", {
        clipPath: "polygon(100% 50%, 0% 50%, 0% 50%, 0% 50%, 0% 50%, 0% 50%)",
        yPercent: -10,
      });

      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: "#examples",
          start: "top 50%",
          end: "55% 50%",
          scrub: true,
          invalidateOnRefresh: true,
        },
      });

      tl.fromTo(".examples-panel", { yPercent: -10 }, { yPercent: 0, ease: "linear", duration: 1 })
        .to(
          ".examples-panel",
          {
            clipPath: "polygon(100% 50%, 0% 0%, 0% 0%, 0% 48%, 0% 100%, 0% 100%)",
            ease: "linear",
            duration: 1,
          },
          "<",
        )
        .to(".examples-panel", {
          clipPath: "polygon(100% 50%, 100% 0%, 0% 0%, 0% 48%, 0% 100%, 100% 100%)",
          ease: "linear",
          duration: 1,
        });
    });

    return () => ctx.revert();
  }, []);

  const animateTextIn = () => {
    const split = new SplitText(".slider-content", {
      type: "lines",
      aria: "none",
      linesClass: "line",
      mask: "lines",
    });

    gsap.set(split.lines, { yPercent: 100, opacity: 0 });

    gsap.to(split.lines, {
      yPercent: 0,
      opacity: 1,
      stagger: 0.04,
      duration: 0.4,
      ease: "power2.out",
    });

    gsap.fromTo(".slider-image", { opacity: 0 }, { opacity: 1, duration: 0.4, ease: "power2.out" });
  };

  const animateSlideChange = (direction) => {
    if (isAnimating) return;
    setIsAnimating(true);

    const oldSplit = new SplitText(".slider-content", {
      type: "lines",
      aria: "none",
      linesClass: "line",
      mask: "lines",
    });

    const tl = gsap.timeline({
      onComplete: () => {
        setCurrent((prev) => (direction === "next" ? (prev + 1) % slides.length : (prev - 1 + slides.length) % slides.length));
      },
    });

    tl.to(oldSplit.lines, {
      yPercent: -100,
      opacity: 0,
      stagger: 0.04,
      duration: 0.4,
      ease: "power2.inOut",
    }).to(".slider-image", { opacity: 0, duration: 0.3, ease: "power2.inOut" }, "<");
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
  }, [current]);

  const slide = slides[current];
  const facts = [
    ["Market", slide.ticker],
    ["Asset class", slide.assetClass],
    ["Market type", slide.marketType],
    ["Network", slide.network],
  ];

  return (
    <section id="examples" aria-label="Example markets" className="relative h-[150vh] z-0 bg-white">
      <style jsx>{`
        .line {
          overflow: hidden;
          display: block;
        }
      `}</style>

      <div className="sticky top-0 h-screen w-full overflow-hidden">
        <div className="examples-panel h-full w-full bg-[#FFFFFF] text-black flex flex-col justify-between px-[2vw] pt-[clamp(64px,5.2vw,92px)] pb-[4vh]">
          {/* HEADER */}
          <div className="grid grid-cols-4 gap-[3vw] uppercase mb-[4vh]">
            {facts.map(([label, value]) => (
              <div key={label}>
                <p className="font-body text-[clamp(10px,0.75vw,13px)] font-semibold tracking-[0.14em] text-black/55">{label}</p>
                <p key={`${label}-${current}`} className="mt-[0.3vw] text-[clamp(13px,1vw,18px)] font-medium tracking-[0.06em] slider-content">
                  {value}
                </p>
              </div>
            ))}
          </div>

          {/* MAIN SLIDE CONTENT */}
          <div key={`slide-${current}`} className="flex flex-1 items-stretch gap-[3vw]">
            <div className="w-[42%] flex items-center slider-content text-[2.4vw] leading-[1.15] font-display">{slide.quote}</div>

            <div className="flex-1 flex items-center justify-center">
              <Image
                src={slide.image}
                alt={slide.alt}
                width={1600}
                height={1000}
                sizes="55vw"
                className="w-full h-[55vh] object-cover rounded-[1.5vw] slider-image"
              />
            </div>
          </div>

          {/* CONTROLS */}
          <div className="flex justify-between items-center mt-[3vh]">
            <div className="flex gap-[1vw]">
              <button type="button" aria-label="Previous market" onClick={() => animateSlideChange("prev")} className="cursor-pointer">
                <IconButton icon="/assets/icons/prev-icon.svg" alt="" bg="#F1F0FB" pad="w-[3.5vw] h-[3.5vw] min-w-10 min-h-10" />
              </button>
              <button type="button" aria-label="Next market" onClick={() => animateSlideChange("next")} className="cursor-pointer">
                <IconButton icon="/assets/icons/next-icon.svg" alt="" bg="#F1F0FB" pad="w-[3.5vw] h-[3.5vw] min-w-10 min-h-10" />
              </button>
            </div>

            <div className="flex gap-[0.4vw] font-body text-[clamp(12px,0.9vw,15px)] font-semibold tracking-[0.14em] text-black/45 tabular-nums">
              <span key={`count-${current}`} className="slider-content text-black">
                {String(current + 1).padStart(2, "0")}
              </span>
              <span>/ {String(slides.length).padStart(2, "0")}</span>
            </div>

            <div>
              <Btn text="Open the market" href={APP_URL} newTab bgColor="bg-[#9C93E8]" />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

export default Examples;
