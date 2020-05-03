gst-launch-1.0 -em \
  rtpbin name=rtpbin latency=5 \
  udpsrc port=10000 caps="application/x-rtp,media=(string)audio,clock-rate=(int)48000,encoding-name=(string)OPUS" ! rtpbin.recv_rtp_sink_0 \
    rtpbin. ! queue ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! voaacenc ! mux. \
  udpsrc port=10002 caps="application/x-rtp,media=(string)video,clock-rate=(int)90000,encoding-name=(string)H264" ! rtpbin.recv_rtp_sink_1 \
    rtpbin. ! queue ! rtph264depay ! h264parse ! mux. \
  flvmux name=mux streamable=true ! rtmpsink sync=false location=rtmp://live-yto.twitch.tv/app/live_507689543_JmLNgzrtwMMnnmQQNeltKKqVFRTSMq


PEER_V=5076 PEER_IP=127.0.0.1 \
SELF_V=10002 \
CAPS_V="media=(string)video,clock-rate=(int)90000,encoding-name=(string)H264,payload=(int)103" \
bash -c 'gst-launch-1.0 -em \
    rtpsession name=r sdes="application/x-rtp-source-sdes,cname=(string)\"user\@example.com\"" \
    udpsrc port=$SELF_V \
        ! "application/x-rtp,$CAPS_V" \
        ! r.recv_rtp_sink \
    r.recv_rtp_src \
        ! rtph264depay \
        ! decodebin \
        ! autovideosink \
    udpsrc port=$((SELF_V+1)) \
        ! r.recv_rtcp_sink \
    r.send_rtcp_src \
        ! udpsink host=$PEER_IP port=$((PEER_V+1)) sync=false async=false'
