gst-launch-1.0 \
    filesrc location=out.sdp ! sdpdemux name=sdpdm timeout=0 \
    sdpdm.stream_0 ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! voaacenc ! mux. \
    sdpdm.stream_1 ! rtph264depay ! h264parse config-interval=2 ! mux. \
    flvmux name=mux streamable=true ! rtmpsink sync=false location=$RTMP_DEST
