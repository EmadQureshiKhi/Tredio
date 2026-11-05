"use client";
import React, { useEffect, useState, useRef } from "react";
import gsap from "gsap";
import ScrollTrigger from "gsap/dist/ScrollTrigger";
import SplitText from "gsap/dist/SplitText";
import Image from "next/image";

gsap.registerPlugin(ScrollTrigger, SplitText);

export default function ClippedTextSection() {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [nextSlideIndex, setNextSlideIndex] = useState(0);
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [isMouseInSlider, setIsMouseInSlider] = useState(false);
  const [showText, setShowText] = useState(false);
  const textRef = useRef(null);
  const autoPlayTimerRef = useRef(null);
  const sectionRef = useRef(null);
  const maskRef = useRef(null);
  const cursorRef = useRef(null);

  //  Each slide has its own background + text
  const slides = [
    {
      image: "/assets/img/topics-islands.jpg",
      heading: "A topic starts trending on X. The radar picks it up and proposes a market.",
      category: "Topics",
      country: "Radar",
      description: "Elfa, Bluesky, CoinGecko, Wikipedia, Nansen and an AI review find what's rising.",
    },
    {
      image: "/assets/img/crypto-chart.jpg",
      heading: "Bitcoin gets loud. Its attention index moves with it, point by point.",
      category: "Crypto",
      country: "Index",
      description: "The Tredio oracle records every score from 0 to 100.",
    },
    {
      image: "/assets/img/saylor-bitcoin-strategy.avif",
      heading: "A CEO posts and the timeline lights up. Trade the noise, or the stock behind it.",
      category: "Equities",
      country: "Perps",
      description: "Attention perps on the index, asset perps on the asset.",
    },
    {
      image: "/assets/img/coinbase-logo.jpg",
      heading: "Regulation hits the feed. Will the attention be higher tomorrow? Take a side.",
      category: "Outcomes",
      country: "Up / Down",
      description: "Outcome series on an order book, settled in USDC.",
    },
    {
      image: "/assets/img/crypto-act-narrative.jpg",
      heading: "A bill is debated all week. A narrative that big can have a coin of its own.",
      category: "Narratives",
      country: "Coins",
      description: "Trend coins launch on bonding curves.",
    },
  ];

  // GSAP ScrollTrigger for mask animation
  useEffect(() => {
    if (!maskRef.current || !sectionRef.current) return;

    const ctx = gsap.context(() => {
      gsap.to(maskRef.current, {
        yPercent: -120,
        ease: "none",
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: "50% top",
          scrub: true,
          onUpdate: (self) => {
            setScrollProgress(self.progress);
          },
        },
      });
    }, sectionRef);

    return () => ctx.revert();
  }, []);

  // Prevent flickering activation/deactivation
  const isSliderActive = scrollProgress >= 0.88;

  // Auto-play timer
  useEffect(() => {
    if (!isSliderActive || isTransitioning) return;

    // Clear existing timer
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
    }

    // Set new timer for 5 seconds
    autoPlayTimerRef.current = setTimeout(() => {
      nextSlide();
    }, 5000);

    return () => {
      if (autoPlayTimerRef.current) {
        clearTimeout(autoPlayTimerRef.current);
      }
    };
  }, [isSliderActive, currentSlide, isTransitioning]);

  // Animate text whenever slide changes (or when slider activates)
  useEffect(() => {
    if (!isSliderActive || !textRef.current) return;

    setShowText(true);

    const ctx = gsap.context(() => {
      const tl = gsap.timeline({ defaults: { ease: "power3.out" } });

      requestAnimationFrame(() => {
        const splitText = new SplitText(".about-slider-text", {
          type: "lines",
          aria: "none",
          linesClass: "lines",
          mask: "lines",
        });

        tl.from(splitText.lines, {
          yPercent: 100,
          opacity: 0,
          stagger: 0.05,
          duration: 0.3,
          ease: "power2.out",
        });
      });
    }, textRef);

    return () => ctx.revert();
  }, [currentSlide, isSliderActive]);

  // Exit animation when slider deactivates
  useEffect(() => {
    if (isSliderActive || !textRef.current) return;

    const ctx = gsap.context(() => {
      requestAnimationFrame(() => {
        const splitText = new SplitText(".about-slider-text", {
          type: "lines",
          aria: "none",
          linesClass: "lines",
          mask: "lines",
        });

        gsap.to(splitText.lines, {
          yPercent: 100,
          opacity: 0,
          stagger: 0.05,
          duration: 0.3,
          ease: "power2.in",
          onComplete: () => {
            setShowText(false);
          },
        });
      });
    }, textRef);

    return () => ctx.revert();
  }, [isSliderActive]);

  // Slide navigation with transition
  const changeSlide = (newIndex) => {
    if (isTransitioning) return;

    // Clear auto-play timer when manually changing slides
    if (autoPlayTimerRef.current) {
      clearTimeout(autoPlayTimerRef.current);
    }

    setIsTransitioning(true);
    setNextSlideIndex(newIndex);

    // Wait full animation duration (1.2s)
    setTimeout(() => {
      setCurrentSlide(newIndex);
      setIsTransitioning(false);
    }, 1200);
  };

  const nextSlide = () => changeSlide((currentSlide + 1) % slides.length);
  const prevSlide = () =>
    changeSlide((currentSlide - 1 + slides.length) % slides.length);

  // Handle mouse movement - smooth GSAP animation
  const handleMouseMove = (e) => {
    if (!isSliderActive || !cursorRef.current) return;
    const x = e.clientX;
    const y = e.clientY;
    setMousePosition({ x, y });

    // Smooth GSAP animation with overwrite to prevent conflicts
    gsap.to(cursorRef.current, {
      x: x,
      y: y,
      duration: 0.6,
      ease: "power2.out",
      overwrite: "auto",
    });
  };

  // Handle click on screen halves
  const handleScreenClick = (e) => {
    if (!isSliderActive || isTransitioning) return;

    const screenWidth = window.innerWidth;
    const clickX = e.clientX;

    if (clickX < screenWidth / 2) {
      prevSlide();
    } else {
      nextSlide();
    }
  };

  // Get cursor text based on position
  const getCursorText = () => {
    if (!isSliderActive) return "";
    const screenWidth = window.innerWidth;
    return mousePosition.x < screenWidth / 2 ? "Previous" : "Next";
  };

  return (
    <section
      ref={sectionRef}
      id="about"
      className="relative w-screen h-[250vh]"
    >
      <style jsx>{`
        @keyframes expandSingleV {
          0% {
            clip-path: polygon(
              100% 50%,
              100% 49.75%,
              100% 50%,
              0% 50.3%,
              100% 50%
            );
          }
          50% {
            /* Create the angled V shape diagonally */
            clip-path: polygon(
              100% 0%,
              100% 100%,
              100% 100%,
              0% 50.3%,
              99.81% 0.22%
            );
          }
          100% {
            clip-path: polygon(100% 0%, 100% 100%, 0% 100%, 0% 50.3%, 0% 0%);
          }
        }
      `}</style>

      <div className="fixed top-0 z-[-1] left-0 h-screen w-full bg-[#9C93E8]">
        <Image
          src={slides[currentSlide].image}
          alt=""
          fill
          sizes="100vw"
          className="object-cover"
        />
      </div>

      {/* Sticky container - everything is contained within this */}
      <div className="sticky top-0 h-screen w-full overflow-hidden">
        {/* Background Image - positioned relative to sticky container */}
        {/* <div
          className="absolute top-0 left-0 h-full w-full bg-cover bg-center transition-opacity duration-700"
          style={{
            backgroundImage: `url('${slides[currentSlide].image}')`,
          }}
        /> */}

        {/* Clip Path Diagonal V-Shape Transition Overlay */}
        {isTransitioning && (
          <div
            className="absolute top-0 left-0 h-full w-full pointer-events-none overflow-hidden"
            style={{ zIndex: 10 }}
          >
            <div
              className="absolute inset-0 bg-[#9C93E8] origin-center"
              style={{
                clipPath: "polygon(45% 50%, 45% 50%, 45% 50%, 45% 50%)",
                animation: "expandSingleV 1s linear forwards",
              }}
            >
              <Image
                src={slides[nextSlideIndex].image}
                alt=""
                fill
                sizes="100vw"
                className="object-cover"
              />
            </div>
            <div className="absolute inset-0 bg-[#9C93E8] bg-black/20" />
          </div>
        )}

        {/* Moving text mask layer */}
        <div ref={maskRef} className="absolute inset-0 moving-about z-5">
          <svg
            role="img"
            aria-label="Trade what the internet watches. Scored 0 to 100. Recorded live. Traded in USDC."
            viewBox="0 0 1512 823"
            xmlns="http://www.w3.org/2000/svg"
            className="w-full h-full"
            preserveAspectRatio="xMidYMid slice"
          >
            <defs>
              <mask id="text-mask" x="0" y="0" width="100%" height="100%">
                <rect width="100%" height="100%" fill="white" />
                <text
                  fontSize="113"
                  fontWeight="bold"
                  fill="black"
                  textAnchor="middle"
                  fontFamily="system-ui, -apple-system, sans-serif"
                >
                  <tspan x="50%" y="184.7">
                    Trade what the{" "}
                  </tspan>
                  <tspan x="50%" y="298.1">
                    internet watches.
                  </tspan>
                  <tspan x="50%" y="411.5">
                    Scored 0 to 100.{" "}
                  </tspan>
                  <tspan x="50%" y="524.9">
                    Recorded live.{" "}
                  </tspan>
                  <tspan x="50%" y="638.3">
                    Traded in USDC.
                  </tspan>
                </text>
              </mask>
            </defs>
            <rect
              width="100%"
              height="100%"
              fill="#9C93E8"
              mask="url(#text-mask)"
            />
          </svg>
        </div>

        <div className="w-full h-full bg-black/20 absolute inset-0" />

        {/* Clickable overlay for screen halves */}
        {isSliderActive && (
          <div
            className="absolute inset-0 cursor-none"
            onClick={handleScreenClick}
            onMouseMove={handleMouseMove}
            onMouseEnter={() => setIsMouseInSlider(true)}
            onMouseLeave={() => setIsMouseInSlider(false)}
          />
        )}

        {/* Custom cursor text */}
        {isSliderActive && (
          <div
            ref={cursorRef}
            className="absolute pointer-events-none z-50 text-black text-[0.7vw] font-semibold font-body bg-[#9C93E8] backdrop-blur-sm h-[8vw] w-[8vw] rounded-full flex items-center justify-center uppercase max-sm:hidden"
            style={{
              left: 0,
              top: 0,
              transform: "translate(-50%, -50%)",
              opacity: isMouseInSlider ? 1 : 0,
              transition: "opacity 0.3s ease",
            }}
          >
            {getCursorText()}
          </div>
        )}

        {(isSliderActive || showText) && (
          <div
            ref={textRef}
            className="absolute left-[35%] w-[60%] min-h-[20vw] top-[75%] -translate-y-1/2 flex flex-col justify-between gap-3 text-white pointer-events-none max-sm:left-[5vw] max-sm:w-[90vw] max-sm:top-[60%] max-sm:gap-[3vw]"
          >
            {/* Main Heading */}
            <div className="slide-line">
              <h2 className="text-[3.5vw] font-bold w-[90%] leading-[1.1] about-slider-text max-sm:text-[6.5vw] max-sm:w-full">
                {slides[currentSlide].heading}
              </h2>
            </div>

            {/* Description */}
            {/* The second label sits at the same place on every slide: the first column is as wide as the
                longest category plus a gap, and the description keeps to one line at the right. */}
            <div className="grid grid-cols-[11.5vw_auto_1fr] items-baseline max-sm:flex max-sm:flex-col max-sm:items-start max-sm:gap-[1.5vw]">
              <p className="text-[2vw] font-display about-slider-text max-sm:text-[4.5vw]">
                {slides[currentSlide].category}
              </p>
              <p className="text-[2vw] font-display about-slider-text max-sm:text-[4.5vw]">
                {slides[currentSlide].country}
              </p>
              <p className="justify-self-end whitespace-nowrap text-[1.2vw] text-gray-200 about-slider-text max-sm:justify-self-auto max-sm:whitespace-normal max-sm:text-[3.5vw] max-sm:leading-[1.3]">
                {slides[currentSlide].description}
              </p>
            </div>
          </div>
        )}

        {isSliderActive && (
          <div className="absolute w-full h-px bg-white opacity-40 top-[50%]" />
        )}

        {/* Navigation */}
        {/* {isSliderActive && (
          <div className="absolute inset-0 flex items-center justify-between px-8 pointer-events-none">
            <button
              onClick={prevSlide}
              className="pointer-events-auto bg-white/20 hover:bg-white/30 backdrop-blur-sm text-white p-4 rounded-full transition-all duration-300"
              aria-label="Previous slide"
            >
              <svg
                width="48"
                height="48"
                viewBox="0 0 48 48"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M30 36L18 24L30 12"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              onClick={nextSlide}
              className="pointer-events-auto bg-white/20 hover:bg-white/30 backdrop-blur-sm text-white p-4 rounded-full transition-all duration-300"
              aria-label="Next slide"
            >
              <svg
                width="48"
                height="48"
                viewBox="0 0 48 48"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M18 36L30 24L18 12"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        )} */}

        {/* Indicators */}
        {/* {isSliderActive && (
          <div className="absolute bottom-8 left-0 right-0 flex justify-center gap-2">
            {slides.map((_, index) => (
              <button
                key={index}
                onClick={() => changeSlide(index)}
                className={`w-3 h-3 rounded-full transition-all duration-300 ${
                  currentSlide === index ? "bg-white w-8" : "bg-white/50"
                }`}
                disabled={isTransitioning}
              />
            ))}
          </div>
        )} */}
      </div>
    </section>
  );
}
