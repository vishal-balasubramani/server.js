document.addEventListener("DOMContentLoaded", function () {
  function showToast(message, type = "success") {
    const toastContainer = document.getElementById("toastContainer");
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.innerHTML = `
<i class="${
      type === "success" ? "ri-checkbox-circle-line" : "ri-error-warning-line"
    }"></i>
<span>${message}</span>
`;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add("show");
    }, 100);
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => {
        toastContainer.removeChild(toast);
      }, 300);
    }, 3000);
  }
  const toggleSwitches = document.querySelectorAll(".toggle-switch input");
  toggleSwitches.forEach((toggle) => {
    toggle.addEventListener("change", function () {
      const section = this.closest(".notification-section");
      const notificationType = section
        ? section.querySelector(".font-medium").textContent
        : "Camera";
      const status = this.checked ? "enabled" : "disabled";
      showToast(`${notificationType} ${status}`);
      if (!section) {
        const cameraFeed = document.getElementById("cameraFeed");
        const noConnectionFeed = document.getElementById("noConnectionFeed");
        if (this.checked) {
          cameraFeed.classList.remove("hidden");
          noConnectionFeed.classList.add("hidden");
        } else {
          cameraFeed.classList.add("hidden");
          noConnectionFeed.classList.remove("hidden");
        }
      }
    });
  });
  // Edit buttons functionality
  const editButtons = document.querySelectorAll("button.text-primary");
  const modal = document.getElementById("editModal");
  const closeModal = document.getElementById("closeModal");
  const cancelEdit = document.getElementById("cancelEdit");
  const editForm = document.getElementById("editForm");
  const contactInput = document.getElementById("contactInput");
  let currentSection = null;
  editButtons.forEach((button) => {
    button.addEventListener("click", function () {
      currentSection = this.closest(".notification-section");
      const currentValue =
        currentSection.querySelector(".text-gray-300").textContent;
      contactInput.value = currentValue;
      modal.classList.add("active");
    });
  });
  
  closeModal.addEventListener("click", () => {
    modal.classList.remove("active");
  });

  cancelEdit.addEventListener("click", () => {
    modal.classList.remove("active");
  });

  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      modal.classList.remove("active");
    }
  });

  editForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (currentSection && contactInput.value.trim()) {
      currentSection.querySelector(".text-gray-300").textContent =
        contactInput.value;
      modal.classList.remove("active");
    }
  });
  // Save preferences button
  const saveButton = document.querySelector("button.bg-primary");
  saveButton.addEventListener("click", function () {
    console.log("Saving preferences...");
    // Show a success message
    alert("Notification preferences saved successfully!");
  });
  // Alert items click
  const alertItems = document.querySelectorAll(".alert-item");
  alertItems.forEach((item) => {
    item.addEventListener("click", function () {
      const alertType = this.querySelector(".font-medium").textContent;
      console.log("Alert clicked:", alertType);
      // In a real app, you would show alert details here
    });
  });
  // Fullscreen button
  const fullscreenButton = document.querySelector(".camera-feed button");
  fullscreenButton.addEventListener("click", function () {
    const cameraFeed = document.querySelector(".camera-feed");
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      cameraFeed.requestFullscreen();
    }
  });
});
