'use strict';

document.addEventListener('DOMContentLoaded', () => {
  const printBtn = document.getElementById('btn-print');
  const closeBtn = document.getElementById('btn-close');
  if (printBtn) printBtn.addEventListener('click', () => window.print());
  if (closeBtn) closeBtn.addEventListener('click', () => window.close());
});
