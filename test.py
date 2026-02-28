import requests
import json
import os
import base64
 
import re
 
router_name = "ray_gateway_router"
NODE_IP="10.200.87.133"
NODE_PORT = 32580
invocation_url = f"http://{NODE_IP}:{NODE_PORT}/v2/models/{router_name}/infer"
 
NODE_IP="svltgpt01a.stjude.org"
# The NodePort for your service
#NODE_PORT = 80
invocation_url = f"https://{NODE_IP}/v2/models/{router_name}/infer"
# ------------------------------------


def get_base64_encoded_image(image_path):
    with open(image_path, "rb") as image_file:
        # Read the binary data of the image
        binary_data = image_file.read()
        # Encode the binary data to base64 bytes
        encoded_bytes = base64.b64encode(binary_data)
        # Decode the bytes to a UTF-8 string
        encoded_string = encoded_bytes.decode('utf-8')
        return encoded_string

 
 
prompt="Can you describe the picture?"
#prompt="https://cdn.britannica.com/61/93061-050-99147DCE/Statue-of-Liberty-Island-New-York-Bay.jpg"

 
 
# Define the payload.
payload = {
    "inputs": [
        {
            "model_name": "qwen3-VL-30B-A3B-Thinking-vllm",
            "inputs": {
                "text": prompt,
                "image": get_base64_encoded_image("assets/icon.png"),
                "max_new_tokens": 65536,
                "temperature": 0.01,
                "top_p": 0.95
            }
        }
    ]
}
 
print(f"Sending request to: {invocation_url}")
#print("Payload:")
print(json.dumps(payload, indent=2))
 
try:
    # Send the POST request
    response = requests.post(
        invocation_url,
        json=payload,
        headers={"Content-Type": "application/json"},
        timeout=1000 # Add a timeout in seconds
    )
   
    # Raise an exception if the call was unsuccessful (e.g., 4xx or 5xx errors)
    response.raise_for_status()
   
    # Parse the JSON response
    result = response.json()
   
    print("\n--- Successful Response ---")
    # The response from the V2 protocol includes model metadata and outputs
    if result and "outputs" in result and isinstance(result["outputs"], list):
        # The actual model output is inside the first element of the "outputs" list
        model_output = result["outputs"][0]
        print(json.dumps(model_output, indent=2))
    else:
        print("Received an unexpected response format:")
        print(result)
 
except requests.exceptions.HTTPError as http_err:
    print(f"\n--- HTTP Error Occurred ---")
    print(f"Status Code: {http_err.response.status_code}")
    print(f"Response Body: {http_err.response.text}")
except requests.exceptions.ConnectionError as conn_err:
    print(f"\n--- Connection Error Occurred ---")
    print(f"Could not connect to {invocation_url}.")
    print("Please check the following:")
    print("1. Is the NODE_IP correct and reachable from your machine?")
    print("2. Is the NODE_PORT correct?")
    print("3. Is there a firewall blocking access to this port?")
    print(f"Original error: {conn_err}")
except Exception as err:
    print(f"\n--- An Error Occurred ---")
    print(err)
 
