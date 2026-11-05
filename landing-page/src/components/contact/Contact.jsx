'use client'
import React, { useState, useRef, useEffect } from 'react';
import { gsap } from 'gsap';
import Btn from '../button/Btn';

const Contact = () => {
  const [activeForm, setActiveForm] = useState('quote');
  const overlayRef = useRef(null);

  // Animate form open/close
  useEffect(() => {
    if (overlayRef.current) {
      if (activeForm === 'contact') {
        gsap.to(overlayRef.current, {
          clipPath: 'polygon(7.75% 0%, 100% 0%, 100% 100%, 11.25% 100%)',
          duration: 1.2,
          ease: 'power3.inOut',
        });
      } else {
        gsap.to(overlayRef.current, {
          clipPath: 'polygon(92.5% 0%, 100% 0%, 100% 100%, 88.5% 100%)',
          duration: 1.2,
          ease: 'power3.inOut',
        });
      }
    }
  }, [activeForm]);

  // --- Hover animations ---
  const handleHover = (side) => {
    if (!overlayRef.current) return;

    if (side === 'contact' && activeForm === 'quote') {
      gsap.to(overlayRef.current, {
        clipPath: 'polygon(90% 0%, 100% 0%, 100% 100%, 86% 100%)',
        duration: 0.6,
        ease: 'power2.out',
      });
    }

    if (side === 'quote' && activeForm === 'contact') {
      gsap.to(overlayRef.current, {
        clipPath: 'polygon(10.5% 0%, 100% 0%, 100% 100%, 14% 100%)',
        duration: 0.6,
        ease: 'power2.out',
      });
    }
  };

  const handleHoverOut = () => {
    if (!overlayRef.current) return;

    if (activeForm === 'contact') {
      gsap.to(overlayRef.current, {
        clipPath: 'polygon(7.75% 0%, 100% 0%, 100% 100%, 11.25% 100%)',
        duration: 0.6,
        ease: 'power2.inOut',
      });
    } else {
      gsap.to(overlayRef.current, {
        clipPath: 'polygon(92.5% 0%, 100% 0%, 100% 100%, 88.5% 100%)',
        duration: 0.6,
        ease: 'power2.inOut',
      });
    }
  };

  // --- Floating label animation ---
  useEffect(() => {
    const inputs = document.querySelectorAll('.float-input');
    inputs.forEach((input) => {
      const label = input.previousElementSibling;

      const animateUp = () => {
        gsap.to(label, {
          y: '-2vw',
          scale: 0.75,
          color: '#1f2937',
          duration: 0.3,
          ease: 'power2.out',
        });
      };

      const animateDown = () => {
        gsap.to(label, {
          y: '0vw',
          scale: 1,
          color: '#6b7280',
          duration: 0.3,
          ease: 'power2.out',
        });
      };

      const checkState = () => {
        if (input.value.trim() !== '') animateUp();
        else animateDown();
      };

      input.addEventListener('focus', animateUp);
      input.addEventListener('blur', checkState);

      // Initialize state
      checkState();
    });
  }, []);

  return (
    <div className="relative w-full h-screen px-[10vw] bg-[#9C93E8] overflow-hidden">
      {/* Base Form - Get a quote */}
      <div className="flex h-full items-center">
        {/* Left Content */}
        <div className="w-[40%] flex items-start justify-start p-[6vw]">
          <div className="max-w-[45vw] space-y-[3vw]">
            <h2 className="text-[2.5vw] font-display leading-[1.2]">Have a project in mind?</h2>
            <p className="text-[1.1vw] leading-relaxed text-gray-700">
              Your vision deserves a partner who listens, challenges and elevates. Share your project with us and let's design an experience that goes beyond expectations. Bold ideas, flawless execution, unforgettable impact.
            </p>
          </div>
        </div>

        {/* Right Form */}
        <div className="w-[60%] flex items-center justify-center p-[5vw]">
          <div className="w-full pt-[5vw] space-y-[2vw]">
            {/* Floating Inputs */}
            {[
              { label: 'Full name*', type: 'text' },
              { label: 'Email address*', type: 'email' },
              { label: 'Phone number', type: 'tel' },
              { label: 'Company name*', type: 'text' },
            ].map((field, i) => (
              <div key={i} className="relative">
                <label className="absolute left-0 top-[40%] text-gray-500 text-[1vw] pointer-events-none origin-left">
                  {field.label}
                </label>
                <input
                  type={field.type}
                  className="float-input w-full bg-transparent border-b border-gray-400 pb-[0.5vw] pt-[1.2vw] text-gray-700 placeholder-transparent focus:outline-none focus:border-gray-700 transition-colors"
                />
              </div>
            ))}

            <div className="space-y-[1vw]">
              <label className="text-[0.7vw] uppercase tracking-wider text-gray-600">PROJECT TYPE</label>
              <div className="relative">
                <select className="w-full bg-transparent border-b border-gray-400 pb-[0.5vw] text-gray-700 appearance-none focus:outline-none focus:border-gray-700 transition-colors cursor-pointer">
                  <option>Corporate Event</option>
                  <option>Wedding</option>
                  <option>Conference</option>
                  <option>Product Launch</option>
                </select>
              </div>
            </div>

            <div className="relative">
              <label className="absolute left-0 top-0 text-gray-500 text-[1vw] pointer-events-none origin-left">
                Tell us more about your project's vision, location, size, timing, and audience.
              </label>
              <textarea
                rows="3"
                className="float-input w-full bg-transparent border-b border-gray-400 pb-[0.5vw] pt-[1.2vw] text-gray-700 placeholder-transparent focus:outline-none focus:border-gray-700 transition-colors resize-none"
              />
            </div>

            <Btn text='Next' bgColor='bg-[#9C93E8] px-[2vw] py-[0.8vw]' />
          </div>
        </div>

        {/* Vertical Text on Right Edge */}
        <div
          className="absolute right-[-7%] top-1/2 -translate-y-1/2 cursor-pointer z-50"
          onMouseEnter={() => handleHover('contact')}
          onMouseLeave={() => handleHoverOut('contact')}
          onClick={() => setActiveForm('contact')}
        >
          <div className="text-[7vw] font-bold leading-none tracking-tight origin-center rotate-90 whitespace-nowrap">
            Contact
          </div>
        </div>
      </div>

      {/* Overlay Form - General Contact */}
      <div
        ref={overlayRef}
        className="absolute inset-0 bg-[#9C93E8] pointer-events-auto px-[10vw]"
        style={{
          clipPath: 'polygon(92.5% 0%, 100% 0%, 100% 100%, 88.5% 100%)',
        }}
      >
        <div className="flex h-screen relative">
          {/* Left Content */}
          <div className="w-[40%] flex items-center justify-center pl-[6vw]">
            <div>
              <h2 className="text-[2.5vw] font-display mb-[3vw] leading-[1.2]">We're looking forward to hear from you</h2>
              <p className="text-[1.1vw] leading-relaxed text-gray-700">
                Every great collaboration starts with a conversation. Whether you're exploring a partnership, joining our team, or simply reaching out, we're here, ready to listen and respond with purpose. Let's connect.
              </p>
            </div>
          </div>

          {/* Right Form */}
          <div className="flex-1 flex items-center justify-center p-[6vw]">
            <div className="w-full max-w-[30vw] space-y-[2.5vw]">
              {[
                { label: 'Full name*', type: 'text' },
                { label: 'Email address*', type: 'email' },
                { label: 'Phone number', type: 'tel' },
              ].map((field, i) => (
                <div key={i} className="relative">
                  <label className="absolute left-0 top-[40%] text-gray-500 text-[1vw] pointer-events-none origin-left">
                    {field.label}
                  </label>
                  <input
                    type={field.type}
                    className="float-input w-full bg-transparent border-b border-gray-400 pb-[0.5vw] pt-[1.2vw] text-gray-700 placeholder-transparent focus:outline-none focus:border-gray-700 transition-colors"
                  />
                </div>
              ))}

              <div className="space-y-[1vw]">
                <label className="text-[0.7vw] uppercase tracking-wider text-gray-600">REASON FOR CONTACT</label>
                <div className="relative">
                  <select className="w-full bg-transparent border-b border-gray-400 pb-[0.5vw] text-gray-700 appearance-none focus:outline-none focus:border-gray-700 transition-colors cursor-pointer">
                    <option>General Inquiry</option>
                    <option>Partnership</option>
                    <option>Career</option>
                    <option>Support</option>
                  </select>
                </div>
              </div>

              <div className="space-y-[1vw]">
                <label className="text-[0.7vw] uppercase tracking-wider text-gray-600">SUPPORTING DOCUMENT</label>
                <button className="flex cursor-pointer items-center gap-[1vw] border border-gray-400 px-[1vw] py-[0.5vw] rounded-[0.6vw] hover:border-gray-700 transition-colors">
                  <span>Upload file</span>
                  <svg width="1.2vw" height="1.2vw" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M8 12V4M8 4L5 7M8 4L11 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
              </div>

              <div className="relative">
                <label className="absolute left-0 top-0 text-gray-500 text-[1vw] pointer-events-none origin-left">
                  Message
                </label>
                <textarea
                  rows="2"
                  className="float-input w-full bg-transparent border-b border-gray-400 pb-[0.5vw] pt-[1.2vw] text-gray-700 placeholder-transparent focus:outline-none focus:border-gray-700 transition-colors resize-none"
                />
              </div>

              <Btn text='send' bgColor='bg-[#9C93E8] px-[2vw] py-[0.8vw]' />
            </div>
          </div>
        </div>
      </div>

      {/* Left Edge Label */}
      <div
        className="absolute left-[-12%] top-1/2 -translate-y-1/2 cursor-pointer z-50"
        onMouseEnter={() => handleHover('quote')}
        onMouseLeave={() => handleHoverOut('quote')}
        onClick={() => setActiveForm('quote')}
      >
        <div className="text-[7vw] font-bold leading-none tracking-tight origin-center -rotate-90 whitespace-nowrap">
          Get a quote
        </div>
      </div>
    </div>
  );
};

export default Contact;
