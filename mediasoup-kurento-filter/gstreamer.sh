gst-launch-1.0 -em \
  rtpbin name=rtpbin latency=5 \
  udpsrc port=10000 caps="application/x-rtp,media=(string)audio,clock-rate=(int)48000,encoding-name=(string)OPUS" ! rtpbin.recv_rtp_sink_0 \
    rtpbin. ! queue ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! voaacenc ! mux. \
  flvmux name=mux streamable=true ! rtmpsink sync=false location=$RTMP_DEST



  udpsrc port=10002 caps="application/x-rtp,media=(string)video,clock-rate=(int)90000,encoding-name=(string)H264" ! rtpbin.recv_rtp_sink_1 \
    rtpbin. ! queue ! rtph264depay ! h264parse ! mux. \

  udpsrc port=10000 caps="application/x-rtp,media=(string)audio,clock-rate=(int)48000,encoding-name=(string)OPUS" ! rtpbin.recv_rtp_sink_0 \
    rtpbin. ! queue ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! voaacenc ! mux. \

PEER_V=36120 PEER_IP=172.31.38.151 \
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

gst-launch-1.0 --eos-on-shutdown \
  rtpbin name=rtpbin \
  filesrc location=/home/ubuntu/mediasoup-demos/mediasoup-recording/recording/input-h264.sdp ! sdpdemux name=demux \
  demux.stream_0 !
  ! rtmpsink sync=false location=$RTMP_DEST



  gst-launch-1.0 filesrc location=/home/ubuntu/mediasoup-demos/mediasoup-recording/recording/output-gstreamer-h264.mp4 ! \
      qtdemux name=demux \
      demux.video_0 ! queue ! \
      decodebin ! videoconvert ! x264enc bitrate=1000 tune=zerolatency ! video/x-h264 ! h264parse ! \
      video/x-h264 ! queue ! flvmux name=mux ! rtmpsink location= \
      demux.audio_0 ! queue ! decodebin ! audioconvert ! audioresample ! \
      audio/x-raw,rate=48000 ! voaacenc bitrate=96000 ! audio/mpeg ! aacparse ! audio/mpeg, mpegversion=4 ! mux.

RTMP_DEST=""
gst-launch-1.0 videotestsrc is-live=true ! \
    videoconvert ! x264enc bitrate=1000 tune=zerolatency ! video/x-h264 ! h264parse ! \
    video/x-h264 ! queue ! flvmux name=mux ! \
    rtmpsink location=$RTMP_DEST audiotestsrc is-live=true ! \
    audioconvert ! audioresample ! audio/x-raw,rate=48000 ! \
    voaacenc bitrate=96000 ! audio/mpeg ! aacparse ! audio/mpeg, mpegversion=4 ! mux.


gst-launch-1.0 audiotestsrc is-live=true ! \
    audioconvert ! audioresample ! audio/x-raw,rate=48000 ! \
    voaacenc bitrate=96000 ! audio/mpeg ! aacparse ! audio/mpeg, mpegversion=4 ! \
    flvmux name=mux ! \
    rtmpsink location=$RTMP_DEST
