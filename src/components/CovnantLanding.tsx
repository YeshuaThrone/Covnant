'use client';

import React, { useState } from 'react';

export default function CovnantLanding() {
  const [step, setStep] = useState('landing');
  const [formData, setFormData] = useState({ legalName: '', artistName: '', email: '', phone: '' });

  const handlePhoneAuth = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    console.log('Pinging device for:', formData.phone);
    alert(`SMS verification sent to ${formData.phone}`);
  };

  return (
    <div className='min-h-screen bg-[#050505] text-white font-sans flex flex-col justify-between p-6'>
      {/* Top nav bar: CV badge, wordmark, entry CTA */}
      <nav className='flex items-center justify-between py-4'>
        <div className='flex items-center gap-3'>
          <div className='w-8 h-8 border border-[#D4AF37] flex items-center justify-center'>
            <span className='text-xs font-bold'>CV</span>
          </div>
          <span className='text-sm tracking-widest uppercase'>COVNANT</span>
        </div>
        <button
          type='button'
          onClick={() => setStep('verify')}
          className='border border-[#D4AF37]/50 text-[#D4AF37] hover:bg-[#D4AF37] hover:text-black rounded-full px-5 py-2 text-sm'
        >
          Enter your world
        </button>
      </nav>

      {/* Hero: CV emblem, wordmark label, tagline, media list */}
      <main className='flex flex-col items-center text-center py-16'>
        <div className='w-24 h-24 border border-[#D4AF37]/60 rounded-2xl bg-[#050505] flex items-center justify-center'>
          <div className='w-20 h-20 border border-[#4E9F3D]/30 rounded-xl flex items-center justify-center'>
            <span className='font-serif text-3xl'>CV</span>
          </div>
        </div>
        <h3 className='mt-8 text-[#D4AF37] text-xs uppercase tracking-widest'>COVNANT</h3>
        <h1 className='mt-4 text-5xl md:text-6xl font-serif tracking-tight text-white'>Own Your Creation.</h1>
        <p className='mt-6 text-gray-400 text-xs md:text-sm tracking-wider uppercase max-w-2xl'>
          Gaming, Music, Movies Tv & Film, Publishing, Streaming, Books, Podcaster, ALL MEDIA
        </p>
      </main>

      {/* Identity verification form — revealed by 'Enter your world' */}
      {step === 'verify' && (
        <div className='flex justify-center pb-12'>
          <form
            onSubmit={handlePhoneAuth}
            className='w-full max-w-md bg-[#050505] border border-[#D4AF37]/40 rounded-xl p-6 text-left space-y-4'
          >
            <div>
              <h3 className='text-[#D4AF37] font-serif'>Identity Verification</h3>
              <p className='mt-1 text-[#888888] text-sm'>
                Enter your details to receive an SMS device ping and enter the world.
              </p>
            </div>
            <div>
              <label htmlFor='legalName' className='block text-[#888888] text-[10px] uppercase tracking-wider'>
                Legal Name
              </label>
              <input
                id='legalName'
                required
                value={formData.legalName}
                onChange={(e) => setFormData({ ...formData, legalName: e.target.value })}
                className='w-full bg-[#050505] border border-[#222222] focus:border-[#4E9F3D] rounded p-3'
              />
            </div>
            <div>
              <label htmlFor='artistName' className='block text-[#888888] text-[10px] uppercase tracking-wider'>
                Artist Name
              </label>
              <input
                id='artistName'
                required
                value={formData.artistName}
                onChange={(e) => setFormData({ ...formData, artistName: e.target.value })}
                className='w-full bg-[#050505] border border-[#222222] focus:border-[#4E9F3D] rounded p-3'
              />
            </div>
            <div>
              <label htmlFor='email' className='block text-[#888888] text-[10px] uppercase tracking-wider'>
                Business Email
              </label>
              <input
                id='email'
                type='email'
                required
                placeholder='name@domain.com'
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                className='w-full bg-[#050505] border border-[#222222] focus:border-[#4E9F3D] rounded p-3'
              />
            </div>
            <div>
              <label htmlFor='phone' className='block text-[#888888] text-[10px] uppercase tracking-wider'>
                Phone Number (SMS Required)
              </label>
              <input
                id='phone'
                type='tel'
                required
                placeholder='(000) 000-0000'
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className='w-full bg-[#050505] border border-[#222222] focus:border-[#4E9F3D] rounded p-3'
              />
            </div>
            <button
              type='submit'
              className='w-full bg-[#D4AF37] text-black font-semibold py-3 rounded text-sm uppercase tracking-wider hover:bg-[#4E9F3D] hover:text-white'
            >
              Send SMS & Enter World
            </button>
          </form>
        </div>
      )}

      {/* Footer */}
      <footer className='py-4 text-center'>
        <span className='text-[#444444] text-xs tracking-widest uppercase'>Covnant Security Engine</span>
      </footer>
    </div>
  );
}
