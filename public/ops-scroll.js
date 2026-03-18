// Scroll-triggered fade-in animation for ops.html.
// Uses IntersectionObserver to add `is-visible` to .fade-in-section elements
// as they enter the viewport. CSS transitions handle the actual animation.
(function () {
  var targets = document.querySelectorAll('.fade-in-section');
  if (!targets.length) return;

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  targets.forEach(function (el) { observer.observe(el); });
}());
