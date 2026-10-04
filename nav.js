// Site nav behavior, shared by every page that carries <nav class="sitenav">.
//
// Mouse: dropdowns open on hover and close 300ms after the cursor leaves, so
// crossing the gap between a label and its menu doesn't drop the menu.
// Touch: hover never fires on a phone, and iOS won't send emulated mouse
// events to a plain <span>, so labels also toggle on tap. Up to 1024px the
// links collapse behind the menu button and the dropdowns open in place.
(function(){
 var nav = document.querySelector(".sitenav");
 if(!nav) return;
 var drops = Array.prototype.slice.call(nav.querySelectorAll(".navdrop"));
 var toggle = document.getElementById("navToggle");
 var narrow = window.matchMedia("(max-width:1024px)");
 // pointerdown fires before the emulated mouseenter a tap produces, so
 // hover handlers can tell a real mouse from a finger.
 var pointer = "mouse";
 document.addEventListener("pointerdown", function(e){ pointer = e.pointerType || "mouse"; }, true);
 var hoverMode = function(){ return pointer === "mouse" && !narrow.matches; };

 function setOpen(d, open){
  d.classList.toggle("open", open);
  var label = d.querySelector(".navlabel");
  if(label) label.setAttribute("aria-expanded", open ? "true" : "false");
 }
 function closeAll(except){ drops.forEach(function(d){ if(d !== except) setOpen(d, false); }); }
 function setMenu(open){
  nav.classList.toggle("nav-open", open);
  if(toggle){
   toggle.setAttribute("aria-expanded", open ? "true" : "false");
   toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
   toggle.innerHTML = open ? "&#10005;" : "&#9776;";
  }
  if(!open) closeAll();
 }

 drops.forEach(function(d){
  var closeTimer = null;
  var label = d.querySelector(".navlabel");
  d.addEventListener("mouseenter", function(){
   if(!hoverMode()) return;
   clearTimeout(closeTimer);
   closeAll(d);
   setOpen(d, true);
  });
  d.addEventListener("mouseleave", function(){
   if(!hoverMode()) return;
   closeTimer = setTimeout(function(){ setOpen(d, false); }, 300);
  });
  if(!label) return;
  label.setAttribute("role", "button");
  label.setAttribute("tabindex", "0");
  label.setAttribute("aria-expanded", "false");
  var flip = function(){
   var open = !d.classList.contains("open");
   closeAll(d);
   setOpen(d, open);
  };
  label.addEventListener("click", function(){
   // With a mouse the menu is already open from hover; a click shouldn't close it.
   if(hoverMode()){ setOpen(d, true); return; }
   flip();
  });
  label.addEventListener("keydown", function(e){
   if(e.key === "Enter" || e.key === " "){ e.preventDefault(); flip(); }
  });
 });

 if(toggle) toggle.addEventListener("click", function(){ setMenu(!nav.classList.contains("nav-open")); });

 document.addEventListener("click", function(e){
  if(nav.contains(e.target)) return;
  closeAll();
  if(nav.classList.contains("nav-open")) setMenu(false);
 });
 document.addEventListener("keydown", function(e){
  if(e.key === "Escape"){ closeAll(); if(nav.classList.contains("nav-open")) setMenu(false); }
 });
 // Rotating a tablet (or resizing past 1024px) shouldn't leave
 // the mobile menu state behind on the desktop layout.
 var onChange = function(){ if(!narrow.matches) setMenu(false); };
 if(narrow.addEventListener) narrow.addEventListener("change", onChange); else if(narrow.addListener) narrow.addListener(onChange);
})();
