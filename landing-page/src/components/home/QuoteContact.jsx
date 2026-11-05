"use client";
import Image from "next/image";
import React, { useRef, useEffect, useState } from "react";
import gsap from "gsap";
import IconButton from "../button/IconButton";
import ScrollTrigger from "gsap/dist/ScrollTrigger";
import Link from "next/link";
import { APP_URL } from "@/config/links";

gsap.registerPlugin(ScrollTrigger);

const QuoteContact = () => {
  const clipRef = useRef(null);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const imageRefs = useRef([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const images = [
    "/assets/img/launch-thumbnails.jpg",
    "/assets/img/launch-thumbnails.jpg",
  ];

  useEffect(() => {
    const clip = clipRef.current;
    const trigger = triggerRef.current;

    const tlEnter = gsap.timeline({ paused: true }).to(clip, {
      clipPath: "polygon(41% 0%, 61.5% 0%, 95.75% 100%, 3.75% 100%)",
      duration: 0.4,
      ease: "power2.out",
    });

    const tlLeave = gsap.timeline({ paused: true }).to(clip, {
      clipPath: "polygon(50% 0%, 50% 0%, 50% 100%, 50% 100%)",
      duration: 0.4,
      ease: "power2.inOut",
    });

    const crossfadeTo = (index) => {
      const current = imageRefs.current[activeIndex];
      const next = imageRefs.current[index];
      if (index === activeIndex) return;
      gsap.set(next, { opacity: 0, zIndex: 2 });
      gsap.to(current, { opacity: 0, duration: 0.2, ease: "power2.inOut" });
      gsap.to(next, {
        opacity: 1,
        duration: 0.2,
        ease: "power2.inOut",
        onComplete: () => setActiveIndex(index),
      });
    };

    const onEnter = () => {
      tlEnter.play(0);
      crossfadeTo(1);
    };
    const onLeave = () => {
      tlLeave.play(0);
      crossfadeTo(0);
    };

    trigger.addEventListener("mouseenter", onEnter);
    trigger.addEventListener("mouseleave", onLeave);

    return () => {
      trigger.removeEventListener("mouseenter", onEnter);
      trigger.removeEventListener("mouseleave", onLeave);
    };
  }, [activeIndex]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo(
        "#quote-wrap",
        { yPercent: -50 },
        {
          yPercent: 0,
          ease: "none",
          scrollTrigger: {
            trigger: "#quote-wrap",
            start: "top bottom",
            end: "bottom 50%",
            scrub: true,
          },
        },
      );
    });
    ScrollTrigger.refresh();
    return () => ctx.revert();
  });

  return (
    <div
      className="h-fit translate-y-[-50%] w-full relative z-50"
      id="quote-wrap"
    >
      <section
        ref={containerRef}
        className="w-full h-screen sticky top-0 overflow-hidden bg-black"
      >
        {/* Image Layer Stack */}
        <div className="absolute inset-0">
          {images.map((src, i) => (
            <Image
              key={i}
              ref={(el) => (imageRefs.current[i] = el)}
              src={src}
              fill
              alt=""
              className={`object-cover absolute top-0 left-0 transition-opacity duration-500 ${
                i === activeIndex ? "opacity-100 z-[1]" : "opacity-0 z-0"
              }`}
              priority
            />
          ))}
        </div>

        {/* LAUNCH heading centered */}
        <div
          className="absolute font-third z-5 top-[35%] left-1/2 -translate-x-1/2 text-[6.5vw] text-[#9C93E8] whitespace-nowrap"
          style={{ textShadow: "0 0 0.15vw #fff, 0 0 1.2vw #fff, 0 0 2.4vw #fff, 0 0 4vw rgba(255,255,255,0.9)" }}
        >
          LAUNCH
        </div>
        {/* Clip Path: full width, expands from center */}
        <div
          ref={clipRef}
          className="absolute flex z-[15] flex-col items-center justify-center gap-[4vw] top-0 left-0 w-full h-full bg-[#9C93E8] pointer-events-none"
          style={{ clipPath: "polygon(50% 0%, 50% 0%, 50% 100%, 50% 100%)" }}
        >
          <div className="w-[25vw] space-y-[2vw] text-black">
            <h2 className="text-[3.5vw] text-center leading-[1.2] font-third">
              Ready to launch and trade?
            </h2>
            <p className="text-[1.3vw] font-medium text-center leading-[1.3]">
              Something is trending right now. Sign in with a passkey and
              trade it on Testnet, gas-free.
            </p>

            <a
              href={APP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="w-fit mx-auto flex items-center gap-[1vw] pointer-events-auto cursor-pointer"
            >
              <p className="text-[0.8vw] font-semibold font-display uppercase">
                Launch App
              </p>
              <IconButton
                icon="/assets/icons/icon-arrow.svg"
                pad="h-[3vw] w-[3vw]"
              />
            </a>
          </div>
        </div>

        {/* Trigger Area: centered */}
        <a
          ref={triggerRef}
          href={APP_URL}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Launch the Tredio app"
          className="absolute top-0 left-1/2 -translate-x-1/2 w-[40%] h-full z-10 cursor-pointer block"
        />
      </section>
    </div>
  );
};

export default QuoteContact;
