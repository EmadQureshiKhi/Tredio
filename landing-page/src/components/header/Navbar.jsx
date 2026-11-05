"use client";
import React, { useState, useRef, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { gsap } from "gsap";
import { useLenis } from "lenis/react";
import { APP_URL, NAV_ITEMS } from "@/config/links";
import useSectionNav from "@/components/hooks/useSectionNav";

export default function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);
    const [hoveredIndex, setHoveredIndex] = useState(null);
  const [hasAnimated, setHasAnimated] = useState(false);
    const [hasAnimated2, setHasAnimated2] = useState(false);

  const lenis = useLenis();
  const goToSection = useSectionNav();

  useEffect(() => {
    gsap.set(".nav-menu-item", {
      yPercent: -100,
    });
    const ctx = gsap.context(() => {
      gsap.fromTo(
        ".nav-menu-item-first",
        {
          yPercent: -100,
        },
        {
          yPercent: 0,
          delay: 0.5,
          ease: "power2.out",
          duration: 0.4,
        }
      );
      gsap.fromTo(
        ".nav-menu-item",
        {
          yPercent: -100,
        },
        {
          yPercent: 0,
          stagger: 0.2,
          duration: 0.7,
          ease: "power2.out",
          delay: 1,
        }
      );
    });
    return () => ctx.revert();
  }, []);

  useEffect(() => {
    if (!lenis) return;

    if (menuOpen) {
      lenis.stop();
    } else {
      lenis.start();
    }
  }, [menuOpen]);

        const menuOverlayRef = useRef(null);

  const navItems = NAV_ITEMS;

  const handleNavClick = (item) => {
    setMenuOpen(false);
    if (item.scrollTo) {
      setTimeout(() => goToSection(item.scrollTo, { offset: 0 }), 400);
    }
  };

  const getClipPathFromPosition = (x, width) => {
    const normalizedX = x / width;
    // Clamp normalizedX between 0.2 and 1 to allow more movement on both sides
    const clampedX = Math.max(0.2, normalizedX);
    const easedX = 1 - Math.pow(1 - clampedX, 2.2);

    const bottomLeftX = 5 + easedX * 75; // Increased from 65 to 70
    const leftY = 5 + easedX * 75; // Increased from 75 to 82
    const leftX = easedX * 7.5; // Increased from 6.5 to 7

    return `polygon(100% 0%, 100% 4.75%, ${bottomLeftX}% 100%, ${leftX}% 100%, ${leftX}% ${leftY}%, 92.5% 0%)`;
  };

  

  

  useEffect(() => {
    const overlay = menuOverlayRef.current;
    if (!overlay) return;

    let ctx = gsap.matchMedia();

    ctx.add("(max-width: 639px)", () => {
      // Mobile: simple translateX sidebar
      gsap.set(overlay, { clipPath: "none" });
      if (menuOpen) {
        gsap.fromTo(
          overlay,
          { x: "-100%" },
          { x: "0%", duration: 0.4, ease: "power2.out" }
        );
      } else {
        gsap.to(overlay, { x: "-100%", duration: 0.35, ease: "power2.in" });
      }
    });

    ctx.add("(min-width: 640px)", () => {
      // Desktop: circle clip-path
      gsap.set(overlay, { x: "0%" });
      const closedClip = "circle(0% at 0% 0%)";
      const openClip = "circle(160% at 0% 0%)";
      if (menuOpen) {
        gsap.fromTo(overlay, { clipPath: closedClip }, { clipPath: openClip, duration: 0.8, ease: "power1.inOut" });
      } else {
        gsap.to(overlay, { clipPath: closedClip, duration: 0.8, ease: "power1.inOut" });
      }
    });

    return () => ctx.revert();
  }, [menuOpen]);

  // Hovering the menu button replays the hamburger lines' draw-in.
  const handleMenuHover = () => {
    if (!hasAnimated) {
      setHasAnimated(true);
      setTimeout(() => setHasAnimated(false), 500);
    }
  };

  

  

  
    

  return (
    <header id="navbar-over" className="space-y-0">
      <div className="w-full flex items-center origin-top nav-menu-item-first justify-center fixed sm:top-0 top-2.5 right-3 z-9999 pt-[1vw] h-[2vw] mix-blend-exclusion invert max-sm:h-[6vw] max-sm:pt-[2vw] pointer-events-none">
        <Link href="/" aria-label="Tredio home" className="h-full pointer-events-auto">
          <Image
            src="/assets/svg/tredio-icon-logo.svg"
            alt=""
            width={4106}
            height={721}
            className="h-full w-auto invert"
          />
        </Link>
      </div>

      <nav
        id="navv"
        className="fixed top-0 left-0 right-0 w-full h-[3vw] flex items-start justify-between z-9999 max-sm:h-[14vw] pointer-events-none"
      >
        {/* Left - Menu */}
        <button
          type="button"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen(!menuOpen);
          }}
          onMouseEnter={handleMenuHover}
          className={`flex  overflow-hidden  nav-menu-item items-center  gap-[1.5vw] pointer-events-auto cursor-pointer outline-none bg-[#9C93E8] px-[1.5vw] h-full py-[1vw] rounded-br-[1vw]   z-10000 relative max-sm:px-[4vw] max-sm:gap-[3vw] max-sm:rounded-br-[3vw] ${menuOpen? '': 'group'}`}
        >
          <div className="flex flex-col w-[1vw] justify-start gap-[0.2vw] relative group cursor-pointer max-sm:w-[5vw] max-sm:gap-[0.7vw]">
            <span
              className={`block h-px max-sm:h-[2px]  bg-black transform origin-left ease-in-out transition-transform duration-100 ${
                hasAnimated ? "scale-x-0" : "scale-x-100"
              } ${
                menuOpen
                  ? "rotate-45 translate-y-[-0.09vw] w-[50%] "
                  : "rotate-0 translate-y-0 w-full"
              }`}
            ></span>

            <span
              className={`block h-px max-sm:h-[2px]  bg-black transform origin-left ease-in-out transition-transform duration-500 delay-100 ${
                hasAnimated ? "scale-x-0" : "scale-x-100"
              } ${
                menuOpen
                  ? "-rotate-45  w-[50%]"
                  : "rotate-0 translate-y-0 w-full"
              }`}
            ></span>
          </div>
          <div className={`relative  flex justify-center items-start h-[1vw] w-[2.5vw] overflow-hidden max-sm:hidden ${menuOpen? 'group': ''}`}>
         {!menuOpen ? (
  
   
      <div className="w-fit px-[0.1vw] flex flex-col group-hover:translate-y-[-1.25vw] group-hover:transition-all group-hover:duration-300 gap-[0.2vw] items-center justify-center">
        <div className="project-top-text w-full h-full flex items-center justify-center overflow-hidden">
          <span className="font-body text-[0.7vw] max-sm:text-[3.5vw] font-semibold text-black">
            MENU
          </span>
        </div>
        <div className="project-top-text group-hover:transition-all group-hover:duration-300 w-full h-full flex items-center justify-center overflow-hidden">
          <span className="font-body text-[0.7vw] max-sm:text-[3.5vw] font-semibold text-black">
            MENU
          </span>
        </div>
      </div>

  ) : (
  
    <div  className="absolute top-1/2 left-1/2  !w-[7vw] h-[1vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden max-sm:!w-[22vw] max-sm:h-[5vw]">
      <div className="w-fit mx-auto px-[0.1vw] flex flex-col group-hover:translate-y-[-1.25vw] group-hover:transition-all group-hover:duration-300 gap-[0.2vw] items-center justify-center">
        <div className="project-top-text w-full h-full flex items-center justify-center overflow-hidden">
          <span className="font-body text-[0.7vw] max-sm:text-[3.5vw] font-semibold text-black">CLOSE</span>
        </div>
        <div className="project-top-text group-hover:transition-all group-hover:duration-300 w-full h-full flex items-center justify-center overflow-hidden">
          <span className="font-body text-[0.7vw] max-sm:text-[3.5vw] font-semibold text-black">CLOSE</span>
        </div>

       
       
      </div>

    </div>

      
  )}
  </div>
        </button>

        {/* Right - Got a Project */}
        <Link
          href={APP_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="relative nav-menu-item pointer-events-auto flex flex-col items-center overflow-hidden justify-center cursor-pointer outline-none bg-[#9C93E8] px-[1vw] h-full py-[1vw] rounded-bl-[1vw] max-sm:px-[4vw] max-sm:rounded-bl-[3vw] z-10002 max-sm:z-[9998] group"
        >
          <div className="relative w-[7vw] flex justify-center items-start h-[1vw] overflow-hidden max-sm:w-[24vw] max-sm:h-[5vw]">
            <div className="w-fit px-[0.1vw] flex flex-col group-hover:translate-y-[-1.25vw] group-hover:transition-all group-hover:duration-300 gap-[0.2vw] items-center justify-center">
              <div className="project-top-text w-full h-full flex items-center justify-center overflow-hidden">
                <span className="font-body text-[0.7vw] max-sm:text-[3.5vw] font-semibold text-black">
                  LAUNCH APP
                </span>
              </div>
              <div className="project-top-text group-hover:transition-all group-hover:duration-300 w-full h-full flex items-center justify-center overflow-hidden">
                <span className="font-body text-[0.7vw] max-sm:text-[3.5vw] font-semibold text-black">
                  LAUNCH APP
                </span>
              </div>
            </div>
          </div>
        </Link>


        {/* MENU OVERLAY */}

        <div
          ref={menuOverlayRef}
          className="fixed top-0 left-0 z-[9999] w-[128vw] h-[125vh] rounded-br-full overflow-hidden max-sm:w-[75vw] max-sm:h-screen max-sm:rounded-none max-sm:shadow-2xl"
          style={{ clipPath: "circle(0% at 0% 0%)" }}
        >
          {" "}
          <div
            className={` w-full h-full navbar-clip-path transition-all duration-700 max-sm:!bg-white max-sm:![clip-path:none] ${
              menuOpen ? "pointer-events-auto" : "pointer-events-none"
            } origin-top-left`}
          >
            <div
              className={`flex flex-col items-end justify-end origin-left mr-[29vw] pb-[calc(25vh+3vw)] h-full text-center space-y-6 max-sm:mr-0 max-sm:px-[8vw] max-sm:items-start max-sm:justify-start max-sm:pt-[25vw] max-sm:pb-[10vw] max-sm:space-y-4  ${
                menuOpen ? "opacity-100 delay" : "opacity-100"
              }`}
            >
              <div className="font-medium text-right flex flex-col items-end justify-end max-sm:text-left max-sm:items-start max-sm:gap-[2vw]">
                {navItems.map((item, i) => (
                  <p
                    key={i}
                    className={`leading-none w-fit h-fit text-right! transition-opacity ease-in-out duration-300 ${
                      hoveredIndex !== null && hoveredIndex !== i
                        ? "opacity-50"
                        : "opacity-100"
                    }`}
                    onMouseEnter={() => setHoveredIndex(i)}
                    onMouseLeave={() => setHoveredIndex(null)}
                  >
                    {item.scrollTo ? (
                      <button
                        onClick={() => handleNavClick(item)}
                        className="font-third text-[4vw] text-right origin-right cursor-pointer transition-colors duration-300 max-sm:text-[8vw] max-sm:text-left max-sm:text-black"
                      >
                        {item.title}
                      </button>
                    ) : (
                      <Link
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-third text-[4vw] text-right origin-right cursor-pointer transition-colors duration-300 max-sm:text-[8vw] max-sm:text-left max-sm:text-black"
                      >
                        {item.title}
                      </Link>
                    )}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* BLACK OVERLAY for MENU */}
        <div
          className={`fixed inset-0 bg-black  transition-opacity duration-700 ${
            menuOpen ? "opacity-60" : "opacity-0"
          } pointer-events-none z-[9998]`}
        ></div>

        
      </nav> 
    </header>
  );
}
