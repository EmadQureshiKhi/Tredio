"use client";
import React, { useRef } from "react";
import { gsap } from "gsap";

// A link when given `href` (newTab opens it in a new tab), a plain button otherwise.
const Btn = ({ text = "Get to know us", bgColor = 'bg-white', href, newTab = false }) => {
  const buttonRef = useRef(null);

  const handleMouseMove = (e) => {
    const rect = buttonRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    // increase tilt strength
    const maxTilt = 20;
    const rotateX = ((y - centerY) / centerY) * maxTilt;
    const rotateY = ((x - centerX) / centerX) * maxTilt;

    gsap.to(buttonRef.current, {
      duration: 0.5,
      rotationX: -rotateX,
      rotationY: rotateY,
      transformPerspective: 600,
      ease: "power2.out",
      overwrite: "auto"
    });
  };

  const handleMouseLeave = () => {
    gsap.to(buttonRef.current, {
      duration: 0.6,
      rotationX: 0,
      rotationY: 0,
      transformPerspective: 600,
      ease: "power2.out",
      overwrite: "auto"
    });
  };

  const className = `relative inline-block px-[1vw] py-[0.5vw] cursor-pointer w-fit font-body uppercase text-black text-[0.7vw] font-semibold rounded-sm ${bgColor}`;
  if (href) {
    return (
      <a ref={buttonRef} href={href} {...(newTab ? { target: "_blank", rel: "noopener noreferrer" } : {})} onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave} className={className}>
        {text}
      </a>
    );
  }
  return (
    <button ref={buttonRef} type="button" onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave} className={className}>
      {text}
    </button>
  );
};

export default Btn;