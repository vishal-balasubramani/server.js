const express = require("express");
const app = express();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const path = require("path");
const mongoose = require("mongoose");
const cors = require("cors");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const connectdb = require("./lib/db.js");
const User = require("./model/opencv.model.js"); // Your User Mongoose model
const session = require("express-session");
const flash = require("connect-flash");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const http = require("http");
const twilio = require("twilio");

// Define port number, ideally from environment variable
const port = process.env.PORT || 3000;

// Create HTTP server for Express
const server = http.createServer(app);

// Create WebSocket server using the HTTP server
const wss = new WebSocket.Server({ server });

// --- Time Range Configuration (Server-side state) ---
let activeTimeRange = {
  startTime: "00:00",
  endTime: "23:59",
  isActive: false,
};

// --- Notification State (Server-side state) ---
let warnCount = 0;
const NOTIFICATION_INTERVAL_MS = 10 * 1000; // 10 seconds
let lastEmailNotificationTime = 0;
let lastSMSNotificationTime = 0;
let lastWebNotificationTime = 0;

let notificationPreferences = {
  email: true,
  sms: true,
  web: true,
};

// --- Email Configuration ---
// IMPORTANT: Use environment variables for production!
// Ensure your Gmail account allows "App Passwords" if 2FA is on.
const emailUser = process.env.EMAIL_USER || "ucamsurveillance@gmail.com";
const emailPass = process.env.EMAIL_PASS || "jxbx fgez lhoq tnsb"; // Use your App Password here

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // Use 'true' for port 465 (SSL), 'false' for 587 (TLS)
  auth: {
    user: emailUser,
    pass: emailPass,
  },
});

// --- Twilio Configuration ---
// UPDATED TWILIO ACCOUNT SID AND AUTH TOKEN
const accountSid =
  process.env.TWILIO_ACCOUNT_SID || "AC0e2e4603a384d6704b1634c721369f62";
const authToken =
  process.env.TWILIO_AUTH_TOKEN || "6ff167552f161bf04fe20392fab0c472";

let twilioClient;
try {
  twilioClient = twilio(accountSid, authToken);
  twilioClient.api
    .accounts(accountSid)
    .fetch()
    .then((account) => {
      console.log(
        "Twilio authentication successful. Account Status:",
        account.status
      );
    })
    .catch((error) => {
      console.error("Twilio authentication failed:", error.message);
      twilioClient = null;
    });
} catch (error) {
  console.error("Error initializing Twilio client:", error.message);
  twilioClient = null;
}

// UPDATED TWILIO PHONE NUMBER
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER || "+15152198402";
const recipientPhoneNumber =
  process.env.RECIPIENT_PHONE_NUMBER || "+919655811578"; // Used as a hint for default country code

// Add camera status tracking
let cameraStatus = {
  isOnline: false,
  lastSeen: null,
  isEnabled: true,
  uptimeStart: null,
};

// Add this near the top with other state variables
let sessionWarnCounts = new Map(); // Map to store warnCount per WebSocket connection
let sessionStartTimes = new Map(); // Map to store session start time per WebSocket connection

// Function to check if current time is within active range
function isWithinActiveTimeRange() {
  if (!activeTimeRange.isActive) return false;

  const now = new Date();
  const currentHours = now.getHours();
  const currentMinutes = now.getMinutes();
  const currentTimeInMinutes = currentHours * 60 + currentMinutes;

  const [startHours, startMinutes] = activeTimeRange.startTime
    .split(":")
    .map(Number);
  const [endHours, endMinutes] = activeTimeRange.endTime.split(":").map(Number);

  const startTimeInMinutes = startHours * 60 + startMinutes;
  const endTimeInMinutes = endHours * 60 + endMinutes;

  if (endTimeInMinutes < startTimeInMinutes) {
    // Range crosses midnight
    return (
      currentTimeInMinutes >= startTimeInMinutes ||
      currentTimeInMinutes <= endTimeInMinutes
    );
  }
  return (
    currentTimeInMinutes >= startTimeInMinutes &&
    currentTimeInMinutes <= endTimeInMinutes
  );
}

// Helper function to broadcast to all connected WebSocket clients
function broadcastToAll(message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Map to store user data associated with each WebSocket client
// Key: WebSocket client object, Value: User data (e.g., { email, phonenumber })
const wsUserDataMap = new Map();

// WebSocket connection handler
wss.on("connection", (ws, req) => {
  console.log("Client connected via WebSocket.");

  // Initialize warnCount and session start time for this session
  sessionWarnCounts.set(ws, 0);
  sessionStartTimes.set(ws, new Date());

  // Initialize camera status upon connection
  cameraStatus.isOnline = true;
  cameraStatus.lastSeen = new Date();
  if (!cameraStatus.uptimeStart) {
    cameraStatus.uptimeStart = new Date();
  }

  broadcastToAll({
    type: "camera_status",
    status: {
      isOnline: cameraStatus.isOnline,
      isEnabled: cameraStatus.isEnabled,
      lastSeen: cameraStatus.lastSeen.toISOString(),
      uptime: cameraStatus.uptimeStart
        ? Math.floor((new Date() - cameraStatus.uptimeStart) / (1000 * 60))
        : 0,
    },
  });

  // Store user data when received
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "user_data") {
        // Store the user data received from the client for this specific WebSocket connection
        if (!data.userData || !data.userData.email) {
          console.warn("Received user data without email:", data.userData);
        } else {
          wsUserDataMap.set(ws, data.userData);
          console.log(
            "User data received via WebSocket for client:",
            data.userData
          );
          console.log("Email received for WS client:", data.userData.email);
        }
        return;
      }

      if (data.type === "image_frame" && data.image_data) {
        cameraStatus.lastSeen = new Date();

        broadcastToAll({
          type: "camera_status",
          status: {
            isOnline: cameraStatus.isOnline,
            isEnabled: cameraStatus.isEnabled,
            lastSeen: cameraStatus.lastSeen.toISOString(),
            uptime: cameraStatus.uptimeStart
              ? Math.floor(
                  (new Date() - cameraStatus.uptimeStart) / (1000 * 60)
                )
              : 0,
          },
        });

        // --- CORRECTED LOGIC FOR CAMERA FEED PROCESSING ---
        if (!cameraStatus.isEnabled) {
          console.log(
            "System inactive: Camera is disabled. Not processing frame."
          );
          ws.send(
            JSON.stringify({
              type: "status_update",
              status: "inactive",
              message: "Camera is currently disabled.",
            })
          );
          return;
        }

        if (activeTimeRange.isActive && !isWithinActiveTimeRange()) {
          console.log(
            "System inactive: Outside active time range. Not processing frame."
          );
          ws.send(
            JSON.stringify({
              type: "status_update",
              status: "inactive",
              message: "System is currently outside active time range.",
            })
          );
          return;
        }
        // If we reach here, camera is enabled AND (either time range is not active, or we are within the active time range)
        // So, proceed with spawning python process
        // --- END CORRECTED LOGIC ---

        const pythonProcess = spawn("python", [
          path.join(__dirname, "BackEnd/detect.py"),
          data.image_data,
        ]);

        let detectionResults = "";
        let errorOutput = "";

        pythonProcess.stdout.on("data", (output) => {
          detectionResults += output.toString();
        });

        pythonProcess.stderr.on("data", (output) => {
          errorOutput += output.toString();
          console.error(`Python script error: ${errorOutput}`);
        });

        pythonProcess.on("close", (code) => {
          if (code === 0) {
            try {
              const results = JSON.parse(detectionResults);
              if (results.human_detected) {
                console.log("Human detected by Python!");
                // Retrieve user data for this specific WebSocket client
                const clientUserData = wsUserDataMap.get(ws);
                console.log(
                  "Debugging SMS send attempt. Current userData object from map:",
                  clientUserData
                );
                handleHumanDetection(
                  results,
                  data.image_data,
                  clientUserData,
                  ws
                );
              } else {
                warnCount = 0; // Reset warnCount if no human is detected
                console.log("No human detected. Warn count reset.");
              }
            } catch (error) {
              console.error("Error parsing JSON from Python:", error.message);
              ws.send(
                JSON.stringify({
                  type: "error",
                  error: "Error processing detection results from Python",
                })
              );
            }
          } else {
            console.error(
              `Python script exited with code ${code}. Error: ${errorOutput}`
            );
            ws.send(
              JSON.stringify({
                type: "error",
                error: `Python script failed with code ${code}. See server logs.`,
              })
            );
          }
        });
      } else if (
        data.type === "camera_toggle" &&
        data.camera_enabled !== undefined
      ) {
        cameraStatus.isEnabled = data.camera_enabled;
        console.log(
          `Camera enabled state updated to: ${cameraStatus.isEnabled}`
        );
        if (!cameraStatus.isEnabled) {
          warnCount = 0; // Reset warn count if camera is disabled
          console.log("Camera disabled by client. Warn count reset.");
        }
        broadcastToAll({
          type: "camera_status",
          status: {
            isOnline: cameraStatus.isOnline,
            isEnabled: cameraStatus.isEnabled,
            lastSeen: cameraStatus.lastSeen
              ? cameraStatus.lastSeen.toISOString()
              : null,
            uptime: cameraStatus.uptimeStart
              ? Math.floor(
                  (new Date() - cameraStatus.uptimeStart) / (1000 * 60)
                )
              : 0,
          },
        });
      }
    } catch (error) {
      console.error("Error processing WebSocket message:", error.message);
      ws.send(
        JSON.stringify({
          type: "error",
          error: "Invalid WebSocket message format",
        })
      );
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected from WebSocket.");
    // Remove user data, warnCount, and session time from map when client disconnects
    wsUserDataMap.delete(ws);
    sessionWarnCounts.delete(ws);
    sessionStartTimes.delete(ws);
    console.log(
      `Client disconnected. Remaining WS clients: ${wss.clients.size}`
    );

    // Only set camera offline if NO clients are connected
    if (wss.clients.size === 0) {
      cameraStatus.isOnline = false;
      cameraStatus.lastSeen = null;
      cameraStatus.uptimeStart = null;
      console.log(
        "Camera status updated to offline as all clients disconnected."
      );
    }

    broadcastToAll({
      type: "camera_status",
      status: {
        isOnline: cameraStatus.isOnline,
        isEnabled: cameraStatus.isEnabled,
        lastSeen: cameraStatus.lastSeen,
        uptime: 0,
      },
    });
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error.message);
    // Remove user data from map on error
    wsUserDataMap.delete(ws);
    console.log(`Client error. Remaining WS clients: ${wss.clients.size}`);

    if (wss.clients.size === 0) {
      cameraStatus.isOnline = false;
      cameraStatus.lastSeen = null;
      cameraStatus.uptimeStart = null;
      warnCount = 0;
      console.log(
        "Camera status updated to offline due to WebSocket error (no clients remaining)."
      );
    }
    broadcastToAll({
      type: "camera_status",
      status: {
        isOnline: cameraStatus.isOnline,
        isEnabled: cameraStatus.isEnabled,
        lastSeen: cameraStatus.lastSeen,
        uptime: 0,
      },
    });
  });
});

// Send SMS notification
async function sendDetectionSMS(body, phoneNumber) {
  if (!twilioClient) {
    console.error("Twilio client not initialized. SMS cannot be sent.");
    return false;
  }
  if (!notificationPreferences.sms) {
    console.log("SMS notifications are disabled in preferences. Not sending.");
    return false;
  }

  // Rate limit for SMS notifications
  const now = Date.now();
  if (now - lastSMSNotificationTime < NOTIFICATION_INTERVAL_MS) {
    console.log(
      `SMS notification rate limit active. Next allowed in ${
        NOTIFICATION_INTERVAL_MS - (now - lastSMSNotificationTime)
      }ms.`
    );
    return false;
  }

  try {
    console.log("Attempting to send SMS...");

    // Format the recipient phone number
    let formattedTo = phoneNumber.replace(/\D/g, ""); // Remove any non-digit characters
    if (!formattedTo.startsWith("91")) {
      formattedTo = "91" + formattedTo; // Add India country code if not present
    }
    formattedTo = "+" + formattedTo; // Add + prefix

    // Format the sender phone number
    const formattedFrom = twilioPhoneNumber.startsWith("+")
      ? twilioPhoneNumber
      : `+${twilioPhoneNumber}`;

    console.log("Formatted phone numbers:", formattedFrom, formattedTo);
    const message = await twilioClient.messages.create({
      body: body,
      from: formattedFrom,
      to: formattedTo,
    });

    console.log("SMS sent successfully! Message SID:", message.sid);
    lastSMSNotificationTime = now; // Update last sent time
    return true;
  } catch (error) {
    console.error("Error sending SMS:", error.message);
    return false;
  }
}

// Handle human detection and notifications
async function handleHumanDetection(results, imageData, userData, ws) {
  const now = Date.now();
  const sessionStartTime = sessionStartTimes.get(ws) || new Date();
  const sessionDuration = Math.floor((now - sessionStartTime.getTime()) / 1000);
  const warnCount = (sessionWarnCounts.get(ws) || 0) + 1;
  sessionWarnCounts.set(ws, warnCount);

  console.log(
    `Human detection #${warnCount} at ${new Date().toLocaleString()} (Session duration: ${sessionDuration}s)`
  );

  let emailSubject = "Security Alert: Human Detected";
  let emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
        <h2 style="color: #dc3545; margin: 0;">Security Alert</h2>
      </div>
      <div style="margin-bottom: 20px;">
        <p style="font-size: 16px; line-height: 1.5; color: #333;">
          A human has been detected by the security camera.
        </p>
      </div>
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
        <p style="margin: 0; color: #666;">
          <strong>Detection Time:</strong> ${new Date().toLocaleString()}
        </p>
        <p style="margin: 5px 0 0 0; color: #666;">
          <strong>Session Duration:</strong> ${sessionDuration} seconds
        </p>
        <p style="margin: 5px 0 0 0; color: #666;">
          <strong>Warning Level:</strong> ${warnCount}
        </p>
      </div>
      <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
        <p style="color: #666; font-size: 14px;">
          This is an automated security alert. Please take necessary action.
        </p>
      </div>
    </div>
  `;
  let smsBody = "Human detected.";

  // Escalate messages based on warnCount
  if (warnCount === 1) {
    emailSubject = "Security Alert: Human Detected";
    smsBody = "Security Alert: Human detected.";
  } else if (warnCount === 2) {
    emailSubject = "Security Alert: Persistent Human Presence";
    emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
        <div style="background-color: #fff3cd; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
          <h2 style="color: #856404; margin: 0;">Persistent Human Presence</h2>
        </div>
        <div style="margin-bottom: 20px;">
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            A human continues to be detected by the security camera.
          </p>
        </div>
        <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
          <p style="margin: 0; color: #666;">
            <strong>Detection Time:</strong> ${new Date().toLocaleString()}
          </p>
          <p style="margin: 5px 0 0 0; color: #666;">
            <strong>Session Duration:</strong> ${sessionDuration} seconds
          </p>
          <p style="margin: 5px 0 0 0; color: #666;">
            <strong>Warning Level:</strong> ${warnCount}
          </p>
        </div>
        <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
          <p style="color: #666; font-size: 14px;">
            This is an automated security alert. Please take necessary action.
          </p>
        </div>
      </div>
    `;
    smsBody = "ALERT: Persistent human detected.";
  } else if (warnCount >= 3) {
    emailSubject = `Security Alert: HIGH DANGER (Warning ${warnCount})`;
    emailBody = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
        <div style="background-color: #dc3545; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
          <h2 style="color: white; margin: 0;">HIGH DANGER ALERT</h2>
        </div>
        <div style="margin-bottom: 20px;">
          <p style="font-size: 16px; line-height: 1.5; color: #333;">
            ⚠️⚠️ A human has been detected for an extended period (~${
              warnCount * (NOTIFICATION_INTERVAL_MS / 1000)
            } seconds estimated) by the security camera.💀⚠️
          </p>
        </div>
        <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
          <p style="margin: 0; color: #666;">
            <strong>Detection Time:</strong> ${new Date().toLocaleString()}
          </p>
          <p style="margin: 5px 0 0 0; color: #666;">
            <strong>Session Duration:</strong> ${sessionDuration} seconds
          </p>
          <p style="margin: 5px 0 0 0; color: #666;">
            <strong>Warning Level:</strong> ${warnCount}
          </p>
          <p style="margin: 5px 0 0 0; color: #666;">
            <strong>Duration:</strong> ~${
              warnCount * (NOTIFICATION_INTERVAL_MS / 1000)
            } seconds
          </p>
        </div>
        <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
          <p style="color: #666; font-size: 14px;">
            This is an automated security alert. Please take immediate action.
          </p>
        </div>
      </div>
    `;
    smsBody = `HIGH DANGER: Human detected for ~${
      warnCount * (NOTIFICATION_INTERVAL_MS / 1000)
    }s.`;
  }

  // Send email notification if enabled and within rate limit
  if (
    notificationPreferences.email &&
    now - lastEmailNotificationTime >= NOTIFICATION_INTERVAL_MS
  ) {
    if (!userData?.email) {
      console.log(
        "Email notification skipped - Missing email in user data for this client."
      );
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      sendDetectionEmail(
        emailSubject,
        emailBody,
        imageData,
        timestamp,
        userData.email
      );
      console.log("Email notification sent to:", userData.email);
      lastEmailNotificationTime = now; // Update last sent time
    }
  } else if (notificationPreferences.email) {
    console.log(
      `Email notification skipped - rate limit active. Next allowed in ${
        NOTIFICATION_INTERVAL_MS - (now - lastEmailNotificationTime)
      }ms.`
    );
  } else {
    console.log("Email notification skipped - disabled in preferences");
  }

  // Send SMS notification if enabled, within rate limit, and for high danger conditions
  if (notificationPreferences.sms && warnCount >= 3) {
    // Only send SMS for high danger
    // The userData here comes from the wsUserDataMap
    if (!userData?.phonenumber) {
      console.log(
        "SMS not sent - Missing phone number in user data for this client."
      );
    } else {
      console.log(
        "Preparing to send SMS - User data (with phone number):",
        userData
      );
      const smsSent = await sendDetectionSMS(smsBody, userData.phonenumber);
      if (smsSent) {
        console.log("SMS notification sent successfully");
      } else {
        console.log("Failed to send SMS notification");
      }
    }
  } else if (notificationPreferences.sms) {
    console.log(
      `SMS notification skipped (warnCount: ${warnCount}) - only sent for warnCount >= 3, or rate limit active.`
    );
  } else {
    console.log("SMS notification skipped - disabled in preferences");
  }

  // --- MODIFIED: Broadcast to web clients ONLY if web notifications are enabled and within rate limit ---
  if (
    notificationPreferences.web &&
    now - lastWebNotificationTime >= NOTIFICATION_INTERVAL_MS
  ) {
    broadcastToAll({
      type: "motion_detected",
      data: {
        ...results,
        detectionTime: new Date().toLocaleString(),
        imageData: imageData,
        warnCount: warnCount,
      },
    });
    console.log("Web notification broadcast sent");
    lastWebNotificationTime = now; // Update last web notification time
  } else if (notificationPreferences.web) {
    console.log(
      `Web notification skipped - rate limit active. Next allowed in ${
        NOTIFICATION_INTERVAL_MS - (now - lastWebNotificationTime)
      }ms.`
    );
  } else {
    console.log(
      "Web notifications disabled in preferences. Not broadcasting motion detection."
    );
  }
}

// Send email notification with image attachment
function sendDetectionEmail(
  subject,
  body,
  imageData,
  timestamp,
  recipientEmail
) {
  const fullSubject = `${subject} on ${timestamp}`;
  const toEmail = recipientEmail; // Remove fallback email, use only the provided email

  const mailOptions = {
    from: emailUser,
    to: toEmail,
    subject: fullSubject,
    html: `<p>${body}</p><br><p>Captured at: ${timestamp}</p>`,
    attachments: [
      {
        filename: "human_detected.jpg",
        content: imageData.split("base64,")[1],
        encoding: "base64",
        cid: "unique@nodemailer.com",
      },
    ],
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.error("Error sending detection email:", error.message);
    } else {
      console.log("Detection email sent:", info.response);
    }
  });
}

// Update time range endpoint
app.post("/api/set-time-range", (req, res) => {
  const { startTime, endTime, isActive } = req.body;

  const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
    return res.status(400).json({
      error: "Invalid time format. Use HH:MM format.",
    });
  }

  activeTimeRange = {
    startTime,
    endTime,
    isActive: isActive !== undefined ? isActive : false,
  };
  console.log("Time range updated:", activeTimeRange);

  res.json({
    message: "Time range updated successfully",
    activeTimeRange,
    cameraStatus,
  });
});

// Add endpoint to get current time range
app.get("/api/get-time-range", (req, res) => {
  res.json(activeTimeRange);
});

// Add endpoint to get current camera status
app.get("/api/camera-status", (req, res) => {
  res.json({
    isOnline: cameraStatus.isOnline,
    isEnabled: cameraStatus.isEnabled,
    lastSeen: cameraStatus.lastSeen
      ? cameraStatus.lastSeen.toISOString()
      : null,
    uptime: cameraStatus.uptimeStart
      ? Math.floor((new Date() - cameraStatus.uptimeStart) / (1000 * 60))
      : 0,
  });
});

// --- Express App Configuration ---
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(
  express.urlencoded({
    extended: true,
  })
);
app.use(
  express.json({
    limit: "50mb",
  })
);
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "yourSuperSecretKey",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);
app.use(flash());

// Connect to MongoDB
connectdb();

/**
 * Helper function to format a phone number to E.164 format.
 * Assumes a default country code if the number doesn't start with '+'.
 * @param {string} phoneNumber - The raw phone number string.
 * @returns {string} The formatted E.164 phone number, or null if invalid.
 */
function formatToE164(phoneNumber) {
  if (!phoneNumber) return null;

  // Remove all non-digit characters except for a leading '+'
  let cleanedNumber = phoneNumber.replace(/[^\d+]/g, "");

  // If it starts with '+', it's likely already in a good format or close to it
  if (cleanedNumber.startsWith("+")) {
    // Basic validation for E.164: starts with +, followed by 1-15 digits
    if (/^\+[1-9]\d{1,14}$/.test(cleanedNumber)) {
      return cleanedNumber;
    }
  } else {
    // If it doesn't start with '+', prepend a default country code
    // IMPORTANT: This assumes a default country (e.g., India's +91).
    // For global users, you'd need to determine country code more dynamically.
    // The recipientPhoneNumber variable is used as a hint for the default country code.
    const defaultCountryCode = recipientPhoneNumber.match(/^\+(\d+)/)?.[1]; // Extracts '91' from '+91...'

    if (defaultCountryCode) {
      // If the number already starts with the default country code (e.g., '91' for India),
      // ensure we don't duplicate it.
      if (!cleanedNumber.startsWith(defaultCountryCode)) {
        cleanedNumber = defaultCountryCode + cleanedNumber;
      }
      cleanedNumber = "+" + cleanedNumber; // Prepend '+'
      if (/^\+[1-9]\d{1,14}$/.test(cleanedNumber)) {
        return cleanedNumber;
      }
    }
  }
  console.warn(
    `Attempted to format invalid phone number: ${phoneNumber}. Result: ${cleanedNumber}`
  );
  return null; // Return null if unable to format to a valid E.164
}

// --- Middleware to attach user details to req.session.user after login ---
// This middleware runs on every request.
// It ensures req.session.user is populated with the latest user data from DB.
app.use(async (req, res, next) => {
  if (req.session && req.session.user && req.session.user.email) {
    try {
      // Find the user by email (or _id if you store that in session)
      // Ensure all necessary fields like phonenumber are fetched
      const user = await User.findOne({
        email: req.session.user.email,
      });

      if (user) {
        // Update req.session.user with the full, fresh data from the database
        // This is crucial for ensuring phonenumber and other details are always current
        req.session.user = {
          _id: user._id, // Include _id if you use it
          name: user.name,
          email: user.email,
          phonenumber: user.phonenumber, // <--- Ensure this is explicitly included
          // Add any other fields you need in the session
        };
        // console.log("req.session.user updated with fresh data:", req.session.user);
      } else {
        // User not found in DB, clear session
        console.warn(
          "User email in session but user not found in database. Destroying session."
        );
        req.session.destroy(() => {
          req.session.user = {}; // Set to empty object instead of null to prevent EJS issues
        });
      }
    } catch (error) {
      console.error(
        "Error fetching user from database in session middleware:",
        error
      );
      req.session.user = {}; // Set to empty object on error to prevent EJS issues
    }
  } else {
    // If no user in session, ensure req.session.user is an empty object for EJS rendering
    req.session.user = req.session.user || {};
  }
  next();
});

// --- Authentication Middleware ---
const accessjwt = (req, res, next) => {
  const authHeaders = req.headers["authorization"];
  const token = authHeaders && authHeaders.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      error: "Token Not provided",
    });
  }

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({
        error: "Token is invalid or expired",
      });
    } else {
      req.user = user; // This `req.user` is for JWT, not session user
      next();
    }
  });
};

const isLoggedIn = (req, res, next) => {
  if (req.session.user && req.session.user._id) {
    // Check for _id to confirm a valid user object
    next();
  } else {
    req.flash("messeage", {
      notify: "Please login first",
      type: "warning",
    });
    res.redirect("/login");
  }
};

// --- Routes ---
app.get("/", (req, res) => {
  if (req.session.user && req.session.user._id) {
    // Check for _id
    res.redirect("/profile");
  } else {
    res.redirect("/login");
  }
});

app.get("/login", (req, res) => {
  if (req.session.user && req.session.user._id) {
    // Check for _id
    return res.redirect("/profile");
  }
  const messeage = req.flash("messeage")[0] || {};
  res.render("regist", {
    formType: "login",
    activeTab: "login",
    messeage,
  });
});

app.get("/profile", isLoggedIn, async (req, res) => {
  const userdetails = req.session.user || {};
  if (!userdetails || !userdetails._id) {
    req.flash("messeage", {
      notify: "Please login first",
      type: "warning",
    });
    return res.redirect("/login");
  }

  // Send admin notification
  try {
    await sendAdminNotification(userdetails);
  } catch (error) {
    console.error("Error sending admin notification:", error);
    // Continue with the profile page even if notification fails
  }

  res.render("profile", {
    userdetails,
    notificationPreferences,
    activeTimeRange,
  });
});

app.get("/signup", (req, res) => {
  const messeage = req.flash("messeage")[0] || {};
  res.render("regist", {
    formType: "signup",
    activeTab: "signup",
    messeage,
  });
});

app.get("/forget-password", (req, res) => {
  const messeage = req.flash("messeage")[0] || {};
  res.render("forgotPassword", {
    messeage,
  });
});

app.get("/resendotp", (req, res) => {
  const messeage = req.flash("messeage")[0] || {};
  res.render("resendotp", {
    messeage,
  });
});

app.get("/OTP", (req, res) => {
  const messeage = req.flash("messeage")[0] || {};
  res.render("OTP", {
    messeage,
  });
});

app.get("/reset-password", (req, res) => {
  const token = req.query.token;
  const messeage = req.flash("messeage")[0] || {};
  res.render("reset-password", {
    token,
    messeage,
  });
});

app.post("/signup", async (req, res) => {
  const { name, email, phonenumber, password, confirmpassword } = req.body;

  try {
    if (await User.findOne({ email: email })) {
      req.flash("messeage", {
        notify: "User with this email already exists",
        type: "danger",
      });
      return res.redirect("/signup");
    } else if (password !== confirmpassword) {
      req.flash("messeage", {
        notify: "Password does not match",
        type: "danger",
      });
      return res.redirect("/signup");
    }

    const formattedPhonenumber = formatToE164(phonenumber);
    if (!formattedPhonenumber) {
      req.flash("messeage", {
        notify:
          "Invalid phone number format. Please include country code (e.g., +91).",
        type: "danger",
      });
      return res.redirect("/signup");
    }

    const OTP = crypto.randomBytes(2).toString("hex");
    const otpexpiry = new Date(Date.now() + 3600000); // 1 hour expiry

    const emailSent = await sendOTPEmail(email, OTP);
    if (!emailSent) {
      req.flash("messeage", {
        notify:
          "Failed to send OTP. Please check your email settings or try again.",
        type: "danger",
      });
      return res.redirect("/signup");
    }

    const hashedpassword = await bcrypt.hash(password, 10);
    const newuser = new User({
      name,
      email,
      phonenumber: formattedPhonenumber,
      password: hashedpassword,
      otp: OTP,
      otpexpiry,
      otpverify: false,
    });
    await newuser.save();

    req.flash("messeage", {
      notify: "OTP sent to your email for verification.",
      type: "success",
    });
    res.redirect("/OTP");
  } catch (err) {
    console.error("Error during signup:", err);
    req.flash("messeage", {
      notify: "An error occurred during signup.",
      type: "danger",
    });
    res.redirect("/signup");
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({
      email: email,
    });

    if (!user) {
      req.flash("messeage", {
        notify: "User not found",
        type: "danger",
      });
      return res.redirect("/login");
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      req.flash("messeage", {
        notify: "Invalid Password",
        type: "danger",
      });
      return res.redirect("/login");
    }

    if (!user.otpverify) {
      // Generate a new OTP
      const newOTP = crypto.randomBytes(2).toString("hex").toLowerCase(); // Ensure lowercase
      const newOtpexpiry = new Date(Date.now() + 3600000); // 1 hour expiry

      try {
        await transporter.sendMail({
          from: emailUser,
          to: user.email,
          subject: "Your New OTP for uCam Verification",
          html: `<h3>Your new One-Time Password (OTP) is: <b>${newOTP}</b></h3><p>This OTP is valid for 1 hour.</p>`,
        });
        console.log(
          `New OTP email sent to ${user.email} during unverified login.`
        );
        // Save the new OTP only if email was sent successfully
        user.otp = newOTP;
        user.otpexpiry = newOtpexpiry;
        await user.save();

        req.flash("messeage", {
          notify:
            "Please verify your account with OTP first. A new OTP has been sent to your email.",
          type: "warning",
        });
        return res.redirect("/OTP"); // Redirect to OTP page
      } catch (emailError) {
        console.error(
          "Error sending new OTP email on unverified login:",
          emailError.message
        );
        req.flash("messeage", {
          notify:
            "Failed to send verification OTP. Please try again or check your email settings.",
          type: "danger",
        });
        return res.redirect("/login"); // Redirect back to login page if email failed
      }
    }

    // Populate req.session.user with full details including phonenumber
    req.session.user = {
      _id: user._id, // Store user ID
      name: user.name,
      email: user.email,
      phonenumber: user.phonenumber, // <--- Ensure phonenumber is stored here
    };
    req.flash("userInfo", {
      name: user.name,
      email: user.email,
      phonenumber: user.phonenumber,
    });
    return res.redirect("/profile");
  } catch (err) {
    console.error("Error during login:", err);
    req.flash("messeage", {
      notify: "An error occurred during login.",
      type: "danger",
    });
    res.redirect("/login");
  }
});

app.post("/forget-password", async (req, res) => {
  const email = req.body.email;
  try {
    const user = await User.findOne({
      email: email,
    });
    if (!user) {
      req.flash("messeage", {
        notify: "User not found",
        type: "danger",
      });
      return res.redirect("/forget-password");
    }

    const token = crypto.randomBytes(32).toString("hex");
    user.resetexpiry = new Date(Date.now() + 3600000);
    user.resettoken = token;
    await user.save();

    try {
      await transporter.sendMail({
        from: emailUser,
        to: email,
        subject: "uCam Password Reset Request",
        html: `<h1>Click here to reset your password: <a href="http://localhost:${port}/reset-password?token=${token}">Reset Password</a></h1><p>This link is valid for 1 hour.</p>`,
      });
      console.log("Reset password email sent successfully.");
    } catch (emailError) {
      console.error("Error sending reset password email:", emailError.message);
      req.flash("messeage", {
        notify: "Failed to send reset email. Please try again.",
        type: "danger",
      });
      return res.redirect("/forget-password");
    }

    req.flash("messeage", {
      notify: "Reset password link sent to your email successfully",
      type: "success",
    });
    return res.redirect("/forget-password");
  } catch (err) {
    console.error("Error during forget password:", err);
    req.flash("messeage", {
      notify: "An error occurred.",
      type: "danger",
    });
    res.redirect("/forget-password");
  }
});

app.post("/reset-password", async (req, res) => {
  const { password, confirmPassword, token } = req.body;
  try {
    if (password !== confirmPassword) {
      req.flash("messeage", {
        notify: "Passwords do not match",
        type: "danger",
      });
      return res.redirect(`/reset-password?token=${token}`);
    }

    const user = await User.findOne({
      resettoken: token,
      resetexpiry: {
        $gt: Date.now(),
      },
    });

    if (!user) {
      req.flash("messeage", {
        notify: "Invalid or expired reset token",
        type: "danger",
      });
      return res.redirect("/forget-password");
    }

    const hashedpassword = await bcrypt.hash(password, 10);
    user.password = hashedpassword;
    user.resettoken = undefined;
    user.resetexpiry = undefined;
    await user.save();

    console.log("Password updated successfully for user:", user.email);
    req.flash("messeage", {
      notify: "Password updated successfully! Please login.",
      type: "success",
    });
    res.redirect("/login");
  } catch (err) {
    console.error("Error during password reset:", err);
    req.flash("messeage", {
      notify: "An error occurred during password reset.",
      type: "danger",
    });
    res.redirect(`/reset-password?token=${token}`);
  }
});

app.post("/OTP", async (req, res) => {
  const otp = req.body.otp ? req.body.otp.trim().toLowerCase() : ""; // Trim and convert to lowercase
  try {
    const user = await User.findOne({
      otp: otp,
    }); // Find by OTP

    if (!user) {
      req.flash("messeage", {
        notify: "Incorrect OTP",
        type: "danger",
      });
      return res.redirect("/OTP");
    }

    if (user.otpexpiry < Date.now()) {
      req.flash("messeage", {
        notify: "OTP has expired",
        type: "danger",
      });
      return res.redirect("/OTP");
    }

    user.otpverify = true;
    user.otpexpiry = undefined;
    user.otp = undefined;
    await user.save();

    console.log("OTP verified successfully for user:", user.email);
    // Update session with full user details after OTP verification
    req.session.user = {
      _id: user._id, // Store user ID
      email: user.email,
      name: user.name,
      phonenumber: user.phonenumber, // <--- Ensure phonenumber is stored here
    };
    req.flash("messeage", {
      notify: "Account verified successfully! Welcome.",
      type: "success",
    });
    return res.redirect("/profile");
  } catch (err) {
    console.error("Error during OTP verification:", err);
    req.flash("messeage", {
      notify: "An error occurred during OTP verification.",
      type: "danger",
    });
    res.redirect("/OTP");
  }
});

app.post("/resendotp", async (req, res) => {
  const email = req.body.email;
  try {
    const user = await User.findOne({ email: email });
    if (!user) {
      req.flash("messeage", {
        notify: "User not found",
        type: "danger",
      });
      return res.redirect("/resendotp");
    }

    const OTP = crypto.randomBytes(2).toString("hex").toLowerCase();
    const otpexpiry = new Date(Date.now() + 3600000);

    const emailSent = await sendOTPEmail(email, OTP);
    if (!emailSent) {
      req.flash("messeage", {
        notify: "Failed to send new OTP. Please try again.",
        type: "danger",
      });
      return res.redirect("/resendotp");
    }

    user.otp = OTP;
    user.otpexpiry = otpexpiry;
    await user.save();

    req.flash("messeage", {
      notify: "New OTP sent to your email.",
      type: "success",
    });
    return res.redirect("/OTP");
  } catch (err) {
    console.error("Error during resend OTP:", err);
    req.flash("messeage", {
      notify: "An error occurred while resending OTP.",
      type: "danger",
    });
    res.redirect("/resendotp");
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Error destroying session:", err);
    }
    res.redirect("/login");
  });
});

app.post("/api/update-notifications", (req, res) => {
  const { type, enabled } = req.body;

  // This route does not need req.user's phonenumber directly,
  // it just updates the server's notificationPreferences state.
  if (
    type &&
    typeof enabled === "boolean" &&
    notificationPreferences.hasOwnProperty(type)
  ) {
    notificationPreferences[type] = enabled;
    console.log(`Notification preference for ${type} updated to: ${enabled}`);

    // If web notifications are disabled, broadcast a status update to clear any existing alerts
    if (type === "web" && !enabled) {
      broadcastToAll({
        type: "status_update",
        status: "active",
        message: "System is active",
        details: {
          detectionTime: new Date().toLocaleString(),
          warnCount: 0,
          type: "web", // Add type to details for client-side filtering
          enabled: false, // Add enabled status to details
        },
      });
      console.log("Web notifications disabled - cleared existing alerts");
    }

    res.json({
      success: true,
      notificationPreferences,
    });
  } else {
    res.status(400).json({
      error: "Invalid request parameters or unknown notification type",
    });
  }
});

app.get("/api/notification-preferences", (req, res) => {
  res.json(notificationPreferences);
});

app.post("/sms-status", (req, res) => {
  const messageStatus = req.body.MessageStatus;
  const messageSid = req.body.MessageSid;
  console.log(
    `SMS Status Update - SID: ${messageSid}, Status: ${messageStatus}`
  );
  res.sendStatus(200);
});

// --- NEW API ENDPOINT: Update User Contact Information ---
app.post("/api/update-user-contact", isLoggedIn, async (req, res) => {
  const { field, value } = req.body;

  // Ensure req.session.user is available (guaranteed by isLoggedIn middleware)
  if (!req.session.user || !req.session.user._id) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized: User not logged in or ID missing.",
    });
  }

  try {
    const user = await User.findById(req.session.user._id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found.",
      });
    }

    if (field === "email") {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return res.status(400).json({
          success: false,
          message: "Invalid email format.",
        });
      }
      user.email = value;
    } else if (field === "phonenumber") {
      // --- Format phonenumber to E.164 before saving ---
      const formattedPhonenumber = formatToE164(value);
      if (!formattedPhonenumber) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid phone number format. Please include country code (e.g., +91).",
        });
      }
      user.phonenumber = formattedPhonenumber; // Use the formatted number
    } else {
      return res.status(400).json({
        success: false,
        message: "Invalid field for update.",
      });
    }

    await user.save();

    // Update the session with the new data immediately
    req.session.user[field] = user.phonenumber; // Use the saved, formatted number

    res.json({
      success: true,
      message: `${field} updated successfully.`,
      updatedValue: user.phonenumber,
    });
  } catch (error) {
    console.error(`Error updating user ${field}:`, error);
    res.status(500).json({
      success: false,
      message: `Server error updating ${field}.`,
    });
  }
});

server.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
  console.log(`WebSocket server is running on ws://localhost:${port}`);
});

// Update the OTP email sending function
async function sendOTPEmail(email, OTP) {
  const emailBody = `
    <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px; background-color: #ffffff;">
      <!-- Header with Logo -->
      <div style="background: linear-gradient(135deg, #4a90e2 0%, #357abd 100%); padding: 30px; border-radius: 10px 10px 0 0; text-align: center; margin: -20px -20px 20px -20px;">
        <h1 style="color: white; margin: 0; font-size: 28px; font-weight: 600; letter-spacing: 0.5px;">uCam Security</h1>
        <p style="color: rgba(255, 255, 255, 0.9); margin: 10px 0 0 0; font-size: 16px;">Verification Code</p>
      </div>

      <!-- Main Content -->
      <div style="padding: 20px 0;">
        <p style="font-size: 16px; line-height: 1.6; color: #333; margin-bottom: 25px;">
          Thank you for choosing uCam Security. To complete your verification, please use the following One-Time Password (OTP):
        </p>

        <!-- OTP Display Box -->
        <div style="background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding: 25px; border-radius: 8px; margin: 30px 0; text-align: center; border: 1px solid #e0e0e0;">
          <p style="margin: 0 0 15px 0; color: #666; font-size: 14px;">Your Verification Code</p>
          <div style="background-color: white; padding: 15px; border-radius: 6px; display: inline-block; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <span style="font-size: 36px; font-weight: bold; color: #4a90e2; letter-spacing: 8px; font-family: 'Courier New', monospace;">${OTP}</span>
          </div>
        </div>

        <!-- Important Information -->
        <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; border-radius: 4px; margin: 25px 0;">
          <p style="margin: 0; color: #856404; font-size: 14px;">
            <strong>Important:</strong> This OTP is valid for 1 hour. Please do not share this code with anyone.
          </p>
        </div>

        <!-- Security Tips -->
        <div style="margin: 25px 0;">
          <h3 style="color: #333; font-size: 16px; margin-bottom: 15px;">Security Tips:</h3>
          <ul style="color: #666; font-size: 14px; line-height: 1.6; margin: 0; padding-left: 20px;">
            <li>Never share your OTP with anyone</li>
            <li>uCam Security will never ask for your OTP via email or phone</li>
            <li>If you didn't request this code, please ignore this email</li>
          </ul>
        </div>
      </div>

      <!-- Footer -->
      <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
        <p style="color: #666; font-size: 13px; margin: 0 0 10px 0;">
          This is an automated message, please do not reply to this email.
        </p>
        <p style="color: #999; font-size: 12px; margin: 0;">
          © ${new Date().getFullYear()} uCam Security. All rights reserved.
        </p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: emailUser,
      to: email,
      subject: "Your uCam Security Verification Code",
      html: emailBody,
    });
    console.log("OTP email sent successfully to:", email);
    return true;
  } catch (error) {
    console.error("Error sending OTP email:", error);
    return false;
  }
}

// Add this function before the routes
async function sendAdminNotification(userDetails) {
  const adminEmail = "pknodeserver@gmail.com"; // Changed to your preferred email
  const emailBody = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 5px;">
      <div style="background-color: #4a90e2; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
        <h2 style="color: white; margin: 0;">New User Profile Access</h2>
      </div>
      <div style="margin-bottom: 20px;">
        <p style="font-size: 16px; line-height: 1.5; color: #333;">
          A user has accessed their profile page.
        </p>
      </div>
      <div style="background-color: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 20px;">
        <p style="margin: 0; color: #666;">
          <strong>User Name:</strong> ${userDetails.name}
        </p>
        <p style="margin: 5px 0 0 0; color: #666;">
          <strong>User Email:</strong> ${userDetails.email}
        </p>
        <p style="margin: 5px 0 0 0; color: #666;">
          <strong>Phone Number:</strong> ${userDetails.phonenumber}
        </p>
        <p style="margin: 5px 0 0 0; color: #666;">
          <strong>Access Time:</strong> ${new Date().toLocaleString()}
        </p>
      </div>
      <div style="text-align: center; margin-top: 20px; padding-top: 20px; border-top: 1px solid #e0e0e0;">
        <p style="color: #666; font-size: 14px;">
          This is an automated notification from uCam Security System.
        </p>
      </div>
    </div>
  `;

  try {
    await transporter.sendMail({
      from: emailUser,
      to: adminEmail,
      subject: "New User Profile Access - uCam Security",
      html: emailBody,
    });
    console.log("Admin notification sent successfully to", adminEmail);
    return true;
  } catch (error) {
    console.error("Error sending admin notification:", error);
    return false;
  }
}
