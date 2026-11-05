"use client";
import React, { useRef } from "react";
import Image from "next/image";
import { gsap } from "gsap";


const IconButton = ({ icon, alt = "", size = "3vw", pad='p-0', bg = "white" }) => {
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

  return (
    <div
      ref={buttonRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={`relative flex items-center p-2 cursor-pointer justify-center   ${pad} rounded-[0.5vw] `}
      style={{ backgroundColor: bg }}
    >
      <Image
        src={icon}
        alt={alt}
        width={100}
        height={100}
        className="w-[60%] h-[60%] object-contain"
      />
    </div>
  );
};

export default IconButton;
