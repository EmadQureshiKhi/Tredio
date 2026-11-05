"use client";
import React, { useState, useRef, useEffect } from "react";
import { gsap } from "gsap";
import { SplitText } from "gsap/SplitText";
import Image from "next/image";
import IconButton from "../button/IconButton";
import MobileBtn from "../button/MobileBtn";
import { APP_URL } from "@/config/links";

gsap.registerPlugin(SplitText);

const CaseStudy = () => {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const currentTextRef = useRef(null);

  const slides = [
    {
      id: 1,
      ticker: "BTC",
      assetClass: "Crypto",
      marketType: "Up / Down",
      network: "Testnet",
      testimonial: "Bitcoin is all over the feed. Will its attention index end the day above where it opened? Buy UP or DOWN on the order book: each winning token redeems for 1 USDC, and each losing token for nothing.",
    },
    {
      id: 2,
      ticker: "HANTA",
      assetClass: "Topic",
      marketType: "Attention Perp",
      network: "Testnet",
      testimonial: "A news cycle has no ticker, but its attention does. Go long while the story spreads, or short it as the feed moves on, with an attention perp.",
    },
    {
      id: 3,
      ticker: "AAPL",
      assetClass: "Equity",
      marketType: "Trend Coin",
      network: "Testnet",
      testimonial: "Keynote day. Back the conversation early with the trend's own coin on its bonding curve, or trade its attention Up or Down.",
    },
  ];

  const animateTextIn = () => {
    const split = new SplitText(
      currentTextRef.current.querySelectorAll(".case-study-text"),
      {
        type: "lines",
        aria: "none",
        linesClass: "line",
      }
    );

    gsap.set(split.lines, { yPercent: 100, opacity: 0 });

    gsap.to(split.lines, {
      yPercent: 0,
      opacity: 1,
      stagger: 0.04,
      duration: 0.4,
      ease: "power2.out",
    });
  };

  const animateSlideChange = (direction) => {
    if (isAnimating) return;
    setIsAnimating(true);

    const nextIndex =
      direction === "next"
        ? (currentSlide + 1) % slides.length
        : (currentSlide - 1 + slides.length) % slides.length;

    const oldSplit = new SplitText(
      currentTextRef.current.querySelectorAll(".case-study-text"),
      {
        type: "lines",
        aria: "none",
        linesClass: "line",
      }
    );

    const tl = gsap.timeline({
      onComplete: () => {
        setCurrentSlide(nextIndex);
      },
    });

    tl.to(oldSplit.lines, {
      yPercent: -100,
      opacity: 0,
      stagger: 0.04,
      duration: 0.4,
      ease: "power2.inOut",
    });
  };

  const handleNext = () => {
    animateSlideChange("next");
  };

  const handlePrev = () => {
    animateSlideChange("prev");
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

  return (
    <div id="casee-study" className="relative w-full min-h-screen bg-gradient-to-b from-gray-50 to-white px-4 py-12">
      <style jsx>{`
        .line {
          overflow: hidden;
          display: block;
        }
      `}</style>

      <div className="max-w-md mx-auto">
        {/* Current Slide Content */}
        <div ref={currentTextRef} className="relative">
          {/* Header Info Grid */}
          <div className="grid grid-cols-2 gap-y-6 mb-24">
            <div>
              <p className="text-[3.5vw] text-gray-700 uppercase tracking-wider mb-1">
                Ticker
              </p>
              <p className="case-study-text text-[5vw]  font-medium text-gray-900">
                {slides[currentSlide].ticker}
              </p>
            </div>
            <div>
              <p className="text-[3.5vw] text-gray-600 uppercase tracking-wider mb-1">
                Asset Class
              </p>
              <p className="case-study-text text-[5vw] font-medium text-gray-900">
                {slides[currentSlide].assetClass}
              </p>
            </div>
            <div>
              <p className="text-[3.5vw] text-gray-600 uppercase tracking-wider mb-1">
                Market Type
              </p>
              <p className="case-study-text text-[5vw] font-medium text-gray-900">
                {slides[currentSlide].marketType}
              </p>
            </div>
            <div>
              <p className="text-[3.5vw] text-gray-600 uppercase tracking-wider mb-1">
                Network
              </p>
              <p className="case-study-text text-[5vw] font-medium text-gray-900">
                {slides[currentSlide].network}
              </p>
            </div>
          </div>

          {/* Testimonial */}
          <div className="mb-8">
            <p className="case-study-text text-[7.5vw] leading-[1.2] text-left text-neutral-800 font-display mb-28">
              {slides[currentSlide].testimonial}
            </p>
          </div>

          {/* Company Logo */}
          


          <div className="flex justify-between">
           

          {/* See Full Case Study Button */}
          <div className="w-[60%]">
            
            <MobileBtn text='OPEN MARKET' href={APP_URL} newTab bgColor='bg-[#9C93E8] text-black' />
          </div>
       

        {/* Navigation */}
        <div className="flex items-center justify-between w-[40%]">
          <div className="text-sm font-medium text-neutral-900">
            {String(currentSlide + 1).padStart(2, "0")} /{" "}
            {String(slides.length).padStart(2, "0")}
          </div>
          <div className="flex gap-3">
            <button
              onClick={handlePrev}
              aria-label="Previous market"
              disabled={isAnimating}
              className="w-10 h-10 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-900 hover:border-gray-900 hover:text-white transition-colors duration-300 disabled:opacity-50"
            >
              <Image
                src="/assets/icons/prev-icon.svg"
                width={20}
                height={20}
                alt=""
                className="w-7 h-7"
              />
            </button>
            <button
              onClick={handleNext}
              aria-label="Next market"
              disabled={isAnimating}
              className="w-10 h-10 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-900 hover:border-gray-900 hover:text-white transition-colors duration-300 disabled:opacity-50"
            >
              <Image
                src="/assets/icons/next-icon.svg"
                width={20}
                height={20}
                alt=""
                className="w-7 h-7"
              />
            </button>
          </div>
        </div>
         </div>
         </div>  
      </div>
    </div>
  );
};

export default CaseStudy;