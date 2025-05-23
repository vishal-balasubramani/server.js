import sys
import time
import json
import cv2
import numpy as np
import base64
import io
from PIL import Image
import os

# --- Human Detection Setup ---
try:
    # Initialize the HOG descriptor for full body detection
    hog = cv2.HOGDescriptor()
    hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

    # Load the Haar Cascade classifier for face detection
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    if not os.path.exists(cascade_path):
        # Print to stderr and exit as this is a critical setup error
        print(json.dumps({
            'error': f'Cascade file not found at {cascade_path}',
            'human_detected': False
        }), file=sys.stderr)
        sys.exit(1)

    face_cascade = cv2.CascadeClassifier(cascade_path)
    if face_cascade.empty():
        # Print to stderr and exit as this is a critical setup error
        print(json.dumps({
            'error': 'Failed to load face cascade classifier',
            'human_detected': False
        }), file=sys.stderr)
        sys.exit(1)
except Exception as e:
    # Catch any other initialization errors
    print(json.dumps({
        'error': f'Error initializing detectors: {str(e)}',
        'human_detected': False
    }), file=sys.stderr)
    sys.exit(1)

def base64_to_image(base64_string):
    """Converts a base64 string to an OpenCV image."""
    try:
        # Handle potential data URL prefix
        if 'base64,' in base64_string:
            base64_data = base64_string.split(',')[1]
        else:
            base64_data = base64_string

        # Remove any whitespace or newlines
        base64_data = base64_data.strip()

        # Decode base64 data
        img_bytes = base64.b64decode(base64_data)
        np_arr = np.frombuffer(img_bytes, np.uint8)

        # Decode image
        image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        if image is None:
            raise ValueError("Failed to decode image data. Decoded image is None.")

        # Verify image dimensions
        if image.size == 0:
            raise ValueError("Image has zero dimensions after decoding.")

        return image
    except Exception as e:
        # Instead of printing and returning None, raise the error
        # so the caller (detect_humans) can handle the specific error.
        raise ValueError(f'Error decoding base64 image: {str(e)}')

def detect_humans(image_data):
    try:
        # Decode base64 image
        image = base64_to_image(image_data)
        # If base64_to_image raised an error, we won't reach here directly,
        # but if it returned None (which the original did), we handle it.
        if image is None: # This check is now less likely to be hit with the `raise` in base64_to_image
             return {'error': 'Failed to decode image (internal)', 'human_detected': False}

        # Make a copy for drawing
        frame = image.copy()

        # Convert to grayscale for face detection
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        # 1. Face Detection using Haar Cascade
        faces = face_cascade.detectMultiScale(
            gray,
            scaleFactor=1.1,
            minNeighbors=5,
            minSize=(30, 30)
        )

        # 2. Full Body Detection using HOG+SVM
        # Ensure the input to hog.detectMultiScale is the colored frame if that's what it expects
        # or convert it to grayscale if the model works better on grayscale for HOG.
        # HOG usually works on grayscale, but the default detector can be applied to color.
        boxes, weights = hog.detectMultiScale(
            frame, # Using frame (color) here as in your original code
            winStride=(8, 8),
            padding=(16, 16),
            scale=1.05
        )

        # Combine detections
        human_detected = len(faces) > 0 or len(boxes) > 0

        # Draw detections for debugging
        # Draw face detections in blue
        for (x, y, w, h) in faces:
            cv2.rectangle(frame, (x, y), (x+w, y+h), (255, 0, 0), 2)
            cv2.putText(frame, 'Face', (x, y-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 0), 2)

        # Draw body detections in green
        for (x, y, w, h) in boxes:
            cv2.rectangle(frame, (x, y), (x+w, y+h), (0, 255, 0), 2)
            cv2.putText(frame, 'Body', (x, y-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

        # Add detection info
        cv2.putText(frame, f'Faces: {len(faces)}', (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 0, 0), 2)
        cv2.putText(frame, f'Bodies: {len(boxes)}', (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)

        # Convert frame back to base64 for debugging
        success, buffer = cv2.imencode('.jpg', frame)
        if not success:
            raise ValueError("Failed to encode debug image")

        debug_image = base64.b64encode(buffer).decode('utf-8')

        # Return results
        result = {
            'human_detected': human_detected,
            'face_count': len(faces),
            'body_count': len(boxes),
            'debug_image': f'data:image/jpeg;base64,{debug_image}'
        }

        # Print to stdout and flush to ensure Node.js receives it immediately
        print(json.dumps(result))
        sys.stdout.flush()
        return result

    except Exception as e:
        # Catch any error during the detection process
        error_result = {
            'error': f'Detection process error: {str(e)}',
            'human_detected': False
        }
        # Print error result to stderr
        print(json.dumps(error_result), file=sys.stderr)
        sys.stderr.flush() # Ensure error is sent
        return error_result

if __name__ == "__main__":
    try:
        # --- CRITICAL CHANGE: Read image data from command-line arguments ---
        if len(sys.argv) < 2:
            print(json.dumps({
                'error': 'No image data provided as command-line argument',
                'human_detected': False
            }), file=sys.stderr)
            sys.exit(1)

        image_data = sys.argv[1] # Read the first command-line argument
        # --- END CRITICAL CHANGE ---

        if not image_data:
            print(json.dumps({
                'error': 'Empty image data received from command-line argument',
                'human_detected': False
            }), file=sys.stderr)
            sys.exit(1)

        result = detect_humans(image_data)
        # The detect_humans function now prints its own output and errors,
        # so we don't need to print it again here.
        # We only need to control the exit code based on the result.
        if 'error' in result and result['error']: # Check if an error occurred during detection
            sys.exit(1) # Exit with error code if detection failed
        else:
            sys.exit(0) # Exit successfully if detection ran (even if no human was detected)
    except Exception as e:
        # Catch any unexpected errors in the main execution block
        print(json.dumps({
            'error': f'Unhandled error in main script: {str(e)}',
            'human_detected': False
        }), file=sys.stderr)
        sys.exit(1)